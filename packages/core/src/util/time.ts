/** UTC ISO-8601（Z 后缀）；与 storage 的 nowIso 同语义（core 不依赖 storage，本包内提供）。 */
export function nowIso(): string {
  return new Date().toISOString();
}
