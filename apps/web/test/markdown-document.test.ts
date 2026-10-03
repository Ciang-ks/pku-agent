import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { expect, it } from "vitest";
import MarkdownDocument from "../src/components/MarkdownDocument.vue";
import { ApiClient } from "../src/api";
async function render(markdown: string) {
  return (await renderToString(createSSRApp({ render: () => h(MarkdownDocument, { markdown, courseId: "course", api: new ApiClient(() => "") }) }))).replace(/<!--.*?-->/g, "");
}
it("renders headings, emphasis, tables and code as readable document structure", async () => {
  const html = await render("# 本节讲义\n\n**定义**与说明。\n\n| 内容 | 页码 |\n|---|---|\n| 特征值 | 3 |\n\n```python\nx = 1\n```");
  expect(html).toContain("<h1>本节讲义</h1>");
  expect(html).toContain("<strong>定义</strong>");
  expect(html).toContain("<table>");
  expect(html).toContain("<td>特征值</td>");
  expect(html).toContain("<pre><code>x = 1</code></pre>");
});
it("keeps raw HTML and unsafe links inert", async () => {
  const html = await render('<script>alert(1)</script>\n\n[unsafe](javascript:alert)\n\n[safe](https://example.org)\n\n![external](https://example.org/track.png)');
  expect(html).not.toContain("<script>");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('<img');
  expect(html).toContain('href="https://example.org"');
});

it("renders model and MinerU math delimiters while leaving code literal", async () => {
  const html = await render('inline $x^2$ and \\(y+1\\).\n\n$$\\frac{1}{2}$$\n\n\\[\\begin{pmatrix}1 & 0\\\\0 & 1\\end{pmatrix}\\]\n\n`$literal$`\n\n```tex\n$x$\n```');
  expect((html.match(/class="katex"/g) ?? []).length).toBe(4);
  expect(html).toContain('<code>$literal$</code>');
  expect(html).toContain('<pre><code>$x$</code></pre>');
  const unsafe = await render('$\\href{javascript:alert(1)}{click}$');
  expect(unsafe).not.toContain('href="javascript:');
});
