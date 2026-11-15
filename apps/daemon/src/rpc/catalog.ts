// projects.* / tasks.* RPC 方法实现（contracts rpc.ts 签名为准，P0-11）：
// 参数 zod strict 校验 → CatalogService 映射；变更后经服务发 task.updated 投影。
import { z } from "zod";
import { TaskStatusSchema } from "@aether/contracts";
import type { JsonRpcRequest } from "@aether/contracts";
import type { CatalogService } from "../catalog/catalog-service.js";
import { invalidParamsOutcome, serviceErrorOutcome, successOutcome } from "./outcomes.js";
import type { RouteOutcome } from "./router.js";

export const CATALOG_METHODS = [
  "projects.list",
  "projects.create",
  "projects.archive",
  "tasks.list",
  "tasks.create",
  "tasks.move",
] as const;
export type CatalogMethod = (typeof CATALOG_METHODS)[number];

export function isCatalogMethod(method: string): method is CatalogMethod {
  return (CATALOG_METHODS as readonly string[]).includes(method);
}

const idField = z.string().min(1);

export const ProjectsCreateParamsSchema = z
  .object({
    name: z.string().min(1),
    rootPath: z.string().min(1),
    gitDefaultBranch: z.string().min(1).optional(),
  })
  .strict();
export const ProjectsArchiveParamsSchema = z.object({ projectId: idField }).strict();
export const TasksCreateParamsSchema = z
  .object({
    projectId: idField,
    title: z.string().min(1),
    description: z.string().optional(),
    parentId: idField.optional(),
  })
  .strict();
export const TasksListParamsSchema = z.object({ projectId: idField }).strict();
export const TasksMoveParamsSchema = z
  .object({
    taskId: idField,
    status: TaskStatusSchema,
    position: z.number().int().nonnegative().optional(),
  })
  .strict();

function requireParams(
  request: JsonRpcRequest,
): { ok: true; params: Record<string, unknown> } | { ok: false; outcome: RouteOutcome } {
  if (request.params === undefined || typeof request.params !== "object") {
    return {
      ok: false,
      outcome: invalidParamsOutcome(request.id, `${request.method} 需要参数对象`),
    };
  }
  return { ok: true, params: request.params as Record<string, unknown> };
}

/** 处理 projects 组与 tasks 组请求（router 已确认 deps.catalog 注入）。 */
export function handleCatalogRequest(
  request: JsonRpcRequest,
  catalog: CatalogService,
): RouteOutcome {
  const { id, method } = request;
  try {
    switch (method) {
      case "projects.list": {
        // 无参方法（AetherRpc 签名），fail-closed：带 params 即拒绝
        if (request.params !== undefined) {
          return invalidParamsOutcome(id, "projects.list takes no params");
        }
        return successOutcome(id, catalog.listProjects());
      }
      case "projects.create": {
        const extracted = requireParams(request);
        if (!extracted.ok) return extracted.outcome;
        const parsed = ProjectsCreateParamsSchema.safeParse(extracted.params);
        if (!parsed.success) {
          return invalidParamsOutcome(id, `projects.create 参数非法：${parsed.error.message}`);
        }
        return successOutcome(id, catalog.createProject(parsed.data));
      }
      case "projects.archive": {
        const extracted = requireParams(request);
        if (!extracted.ok) return extracted.outcome;
        const parsed = ProjectsArchiveParamsSchema.safeParse(extracted.params);
        if (!parsed.success) {
          return invalidParamsOutcome(id, `projects.archive 参数非法：${parsed.error.message}`);
        }
        return successOutcome(id, catalog.archiveProject(parsed.data));
      }
      case "tasks.list": {
        const extracted = requireParams(request);
        if (!extracted.ok) return extracted.outcome;
        const parsed = TasksListParamsSchema.safeParse(extracted.params);
        if (!parsed.success) {
          return invalidParamsOutcome(id, `tasks.list 参数非法：${parsed.error.message}`);
        }
        return successOutcome(id, catalog.listTasks(parsed.data));
      }
      case "tasks.create": {
        const extracted = requireParams(request);
        if (!extracted.ok) return extracted.outcome;
        const parsed = TasksCreateParamsSchema.safeParse(extracted.params);
        if (!parsed.success) {
          return invalidParamsOutcome(id, `tasks.create 参数非法：${parsed.error.message}`);
        }
        return successOutcome(id, catalog.createTask(parsed.data));
      }
      case "tasks.move": {
        const extracted = requireParams(request);
        if (!extracted.ok) return extracted.outcome;
        const parsed = TasksMoveParamsSchema.safeParse(extracted.params);
        if (!parsed.success) {
          return invalidParamsOutcome(id, `tasks.move 参数非法：${parsed.error.message}`);
        }
        return successOutcome(id, catalog.moveTask(parsed.data));
      }
    }
    return invalidParamsOutcome(id, `未知 catalog 方法：${method}`);
  } catch (error) {
    return serviceErrorOutcome(id, error);
  }
}
