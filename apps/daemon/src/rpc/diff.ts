// diff.* RPC 方法实现（contracts rpc.ts 签名为准，P0-11）：
// workspaceId strict 校验 → DiffService（core computeWorkspaceDiff）。异步方法。
import { z } from "zod";
import type { JsonRpcRequest } from "@aether/contracts";
import type { DiffService } from "../diff/diff-service.js";
import { invalidParamsOutcome, serviceErrorOutcome, successOutcome } from "./outcomes.js";
import type { RouteOutcome } from "./router.js";

export const DIFF_METHODS = ["diff.workspaceDiff"] as const;
export type DiffMethod = (typeof DIFF_METHODS)[number];

export function isDiffMethod(method: string): method is DiffMethod {
  return (DIFF_METHODS as readonly string[]).includes(method);
}

export const DiffWorkspaceDiffParamsSchema = z
  .object({
    workspaceId: z.string().min(1),
  })
  .strict();

/** 处理 diff.* 请求（router 已确认 deps.diff 注入）。 */
export function handleDiffRequest(
  request: JsonRpcRequest,
  diff: DiffService,
): Promise<RouteOutcome> {
  const { id, method, params } = request;
  if (method !== "diff.workspaceDiff") {
    return Promise.resolve(invalidParamsOutcome(id, `未知 diff 方法：${method}`));
  }
  if (params === undefined) {
    return Promise.resolve(invalidParamsOutcome(id, "diff.workspaceDiff 需要参数对象"));
  }
  const parsed = DiffWorkspaceDiffParamsSchema.safeParse(params);
  if (!parsed.success) {
    return Promise.resolve(
      invalidParamsOutcome(id, `diff.workspaceDiff 参数非法：${parsed.error.message}`),
    );
  }
  return diff
    .workspaceDiff(parsed.data.workspaceId)
    .then((result) => successOutcome(id, result))
    .catch((error: unknown) => serviceErrorOutcome(id, error));
}
