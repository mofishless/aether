// P0-01 渲染入口：仅证明渲染管线可用。React 骨架在 P0-10 引入。
const app = document.querySelector<HTMLDivElement>("#app");

if (app) {
  app.textContent = "Aether — P0 骨架（空壳）";
}
