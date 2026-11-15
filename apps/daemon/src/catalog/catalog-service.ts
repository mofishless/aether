// projects/tasks 服务（P0-11 驾驶舱，§5.2 projects/tasks 组）：storage repo 直连 +
// 任务变更发 task.updated 投影。项目归档 P0 不发投影（无 project topic；UI 经
// projects.list 全量刷新——P0 返回全部含已归档，展示口径由 UI 决定，任务卡定案）。
import { STATIC_TOPIC, TaskUpdatedPayloadSchema } from "@aether/contracts";
import type { Project, ProjectSummary, Task, TaskStatus } from "@aether/contracts";
import { nowIso } from "@aether/core";
import type { ProjectRepository, TaskRepository } from "@aether/storage";
import type { EventBus } from "../events/event-bus.js";
import { invalidParamsError } from "../service-error.js";

export interface CatalogServiceDeps {
  readonly eventBus: EventBus;
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
}

/** projects.create 入参（contracts 签名对齐；运行时 zod 校验在 RPC 层。
 *  可选字段带 | undefined：zod optional 推断口径一致，exactOptionalPropertyTypes 下直传不炸） */
export interface CreateProjectInput {
  readonly name: string;
  readonly rootPath: string;
  readonly gitDefaultBranch?: string | undefined;
}

/** tasks.create 入参 */
export interface CreateTaskInput {
  readonly projectId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly parentId?: string | undefined;
}

export class CatalogService {
  constructor(private readonly deps: CatalogServiceDeps) {}

  /** 项目清单：P0 返回全部（含已归档），archivedAt 交 UI 展示。 */
  listProjects(): { items: ProjectSummary[] } {
    const items = this.deps.projects.findAll().map(toProjectSummary);
    return { items };
  }

  createProject(input: CreateProjectInput): Project {
    return this.deps.projects.create({
      name: input.name,
      rootPath: input.rootPath,
      ...(input.gitDefaultBranch !== undefined ? { gitDefaultBranch: input.gitDefaultBranch } : {}),
    });
  }

  /** 归档：幂等语义（重复归档保持原 archivedAt，不刷新时间戳）。 */
  archiveProject(input: { projectId: string }): Project {
    const projectId = input.projectId;
    const project = this.deps.projects.findById(projectId);
    if (project === null) {
      throw invalidParamsError(`未知项目：projectId=${projectId}`);
    }
    if (project.archivedAt !== null) {
      return project;
    }
    const archived = this.deps.projects.update(projectId, { archivedAt: nowIso() });
    if (archived === null) {
      throw invalidParamsError(`项目归档后无法读回：projectId=${projectId}`);
    }
    return archived;
  }

  /** 任务清单（tasks.list）：未知项目 → invalid_params；行序（创建序）返回。 */
  listTasks(input: { projectId: string }): { items: Task[] } {
    const projectId = input.projectId;
    const project = this.deps.projects.findById(projectId);
    if (project === null) {
      throw invalidParamsError(`未知项目：projectId=${projectId}`);
    }
    const items = this.deps.tasks.findAll().filter((task) => task.projectId === projectId);
    return { items };
  }

  createTask(input: CreateTaskInput): Task {
    const projectId = input.projectId;
    const project = this.deps.projects.findById(projectId);
    if (project === null) {
      throw invalidParamsError(`未知项目：projectId=${projectId}`);
    }
    const task = this.deps.tasks.create({
      projectId,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.parentId !== undefined ? { parentTaskId: input.parentId } : {}),
    });
    this.publishTaskUpdated(task);
    return task;
  }

  /** 看板移动：status 必填、position 可选（PATCH 语义）。 */
  moveTask(input: { taskId: string; status: TaskStatus; position?: number | undefined }): Task {
    const taskId = input.taskId;
    const existing = this.deps.tasks.findById(taskId);
    if (existing === null) {
      throw invalidParamsError(`未知任务：taskId=${taskId}`);
    }
    const moved = this.deps.tasks.update(taskId, {
      status: input.status,
      ...(input.position !== undefined ? { position: input.position } : {}),
    });
    if (moved === null) {
      throw invalidParamsError(`任务移动后无法读回：taskId=${taskId}`);
    }
    this.publishTaskUpdated(moved);
    return moved;
  }

  private publishTaskUpdated(task: Task): void {
    this.deps.eventBus.publish(STATIC_TOPIC.taskUpdated, { task }, TaskUpdatedPayloadSchema);
  }
}

function toProjectSummary(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    archivedAt: project.archivedAt,
  };
}
