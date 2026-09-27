import { helper } from "./helper";

function a() {
  b();
}

function b() {}

export const run = async () => {
  await a();
  helper.util.go();
  const service = new AuthService();
  service
    .login("x");
  (() => b())();
  items.forEach((item) => format(item));
};

class Widget {
  handler = setup();

  render() {
    this.draw();
    super.render?.();
  }
}

top();
new Map();
tag`x`;
