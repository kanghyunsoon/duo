import fs = require("node:fs");

export function read() {
  return fs.readFileSync("a");
}
