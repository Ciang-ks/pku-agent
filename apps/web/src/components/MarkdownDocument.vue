<script lang="ts">
import { defineComponent, h, type VNodeChild, type PropType } from "vue";
import { type Token } from "marked";
import katex from "katex";
import "katex/dist/katex.min.css";
import { lessonMarkdown } from "../math-markdown";
import type { ApiClient } from "../api";
import ProtectedImage from "./ProtectedImage.vue";

/** Render Markdown as Vue nodes: raw HTML is text, never executable markup. */
export default defineComponent({
  props: { markdown: { type: String, required: true }, courseId: { type: String, required: true }, api: { type: Object as PropType<ApiClient>, required: true } },
  setup(props) {
    const inline = (tokens: Token[] | undefined, fallback = ""): VNodeChild[] => tokens ? tokens.map(render) : [fallback];
    function render(token: Token): VNodeChild {
      switch (token.type) {
        case "mathBlock":
        case "mathInline": return h(token.type === "mathBlock" ? "div" : "span", {
          class: token.type === "mathBlock" ? "lesson-math-block" : "lesson-math-inline",
          innerHTML: katex.renderToString(String(token.text), { displayMode: token.type === "mathBlock", throwOnError: false, trust: false, strict: "ignore" }),
        });
        case "heading": return h(`h${token.depth}`, inline(token.tokens));
        case "paragraph": return h("p", inline(token.tokens));
        case "strong": return h("strong", inline(token.tokens));
        case "em": return h("em", inline(token.tokens));
        case "del": return h("del", inline(token.tokens));
        case "blockquote": return h("blockquote", inline(token.tokens));
        case "codespan": return h("code", token.text);
        case "code": return h("pre", [h("code", token.text)]);
        case "br": return h("br");
        case "hr": return h("hr");
        case "space": return "";
        case "list": return h(token.ordered ? "ol" : "ul", { start: token.start || undefined }, token.items.map((item: { tokens: Token[] }) => h("li", inline(item.tokens))));
        case "table": return h("div", { class: "table-scroll" }, [h("table", [
          h("thead", [h("tr", token.header.map((cell: { tokens: Token[] }) => h("th", inline(cell.tokens))))]),
          h("tbody", token.rows.map((row: { tokens: Token[] }[]) => h("tr", row.map(cell => h("td", inline(cell.tokens))))))])]);
        case "link": return /^https?:\/\//i.test(token.href) ? h("a", { href: token.href, target: "_blank", rel: "noopener noreferrer" }, inline(token.tokens)) : h("span", inline(token.tokens));
        case "image": return token.href.startsWith("materials/") ? h(ProtectedImage, { api: props.api, courseId: props.courseId, path: token.href, alt: token.text }) : h("span", `[图片：${token.text}]`);
        case "text": return inline(token.tokens, token.text);
        default: return "text" in token ? String(token.text) : token.raw;
      }
    }
    return () => h("article", { class: "learning-document" }, lessonMarkdown.lexer(props.markdown).map(render));
  },
});
</script>
