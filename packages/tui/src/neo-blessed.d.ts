// neo-blessed is an API-compatible fork of blessed with no types package of
// its own — @types/blessed's shape matches it closely enough to reuse here
// (it does NOT cover the `terminal` widget either way; see pty-pane.ts's own
// `any` casts for that gap).
declare module "neo-blessed" {
  import blessed = require("blessed");
  export = blessed;
}
