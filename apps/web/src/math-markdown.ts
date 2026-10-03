import { Marked, type TokenizerExtension } from "marked";

function mathExtension(name: string, level: "block" | "inline"): TokenizerExtension {
  const display = level === "block";
  return {
    name, level,
    start(source) {
      const starts = display ? [source.indexOf("$$"), source.indexOf("\\[")] : [source.indexOf("$"), source.indexOf("\\(")];
      const found = starts.filter(n => n >= 0);
      return found.length ? Math.min(...found) : undefined;
    },
    tokenizer(source) {
      const match = display
        ? /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:\n|$)/.exec(source)
        : /^(?:\$(?!\$)([^$\n]+?)\$(?!\$)|\\\(([^\n]+?)\\\))/.exec(source);
      if (!match) return undefined;
      return { type: name, raw: match[0], text: (match[1] ?? match[2] ?? "").trim(), display };
    },
  };
}

export const lessonMarkdown = new Marked({ extensions: [mathExtension("mathBlock", "block"), mathExtension("mathInline", "inline")] });
