// 阶段 2（daemon 生命周期 supervisor）的故障注入 fixture：两种"挂死"模式。
// 不写自动化测试（心跳超时/启动超时判定归阶段 2 集成测试，此处勿重复）。

/**
 * --hang-signal：真正阻塞事件循环（不发 pong、不处理任何帧，ws 心跳必然超时）。
 * 注意必须是真阻塞——只"不回数据"不够，事件循环还得跑着收帧。
 * for(;;) 而非 while(true)：规避 no-constant-condition 对循环条件的告警。
 */
export function blockEventLoopForever(): never {
  for (;;) {
    // 故意空循环：阻塞本身就是目的
  }
}

/** --hang-silent：进程存活但不 bind、不写 stdout（父进程启动就绪检测必然超时） */
export function keepAliveSilently(): void {
  const maxIntervalMs = 2_147_483_647; // 定时器上限（约 24.8 天），仅用于持住事件循环
  setInterval(() => undefined, maxIntervalMs);
}
