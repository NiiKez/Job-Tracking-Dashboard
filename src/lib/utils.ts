import { createCn } from "cn/config";

/**
 * Class merging. `text-meta` is the 13px size from the type scale
 * (globals.css / DESIGN.md); without this the merger reads it as a colour
 * and drops the real colour class next to it.
 */
export const cn = createCn({
  extend: { classGroups: { "font-size": [{ text: ["meta"] }] } },
});
