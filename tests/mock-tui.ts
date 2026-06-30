import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === "@earendil-works/pi-tui") {
    return {
      Box: class MockBox {
        w: number;
        h: number;
        bg: any;
        children: any[] = [];
        constructor(w: number, h: number, bg: any) {
          this.w = w;
          this.h = h;
          this.bg = bg;
        }
        addChild(child: any) {
          this.children.push(child);
        }
      },
      Text: class MockText {
        text: string;
        x: number;
        y: number;
        constructor(text: string, x: number, y: number) {
          this.text = text;
          this.x = x;
          this.y = y;
        }
      }
    };
  }
  return originalRequire.apply(this, arguments);
};
