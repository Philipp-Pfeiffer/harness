import { describe, it, expect, afterEach } from "vitest";
import { processSupervisor, type Task } from "../../src/tools/processSupervisor.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2)}`,
    type: "browser",
    status: "running",
    summary: "",
    artifactPaths: [],
    startedAt: new Date(),
    stop: () => {},
    ...overrides,
  };
}

function terminateRunningTasks(): void {
  for (const task of processSupervisor.listTasks().running) {
    task.status = "stopped";
    task.finishedAt = new Date();
  }
}

describe("processSupervisor in-process tasks", () => {
  afterEach(() => {
    terminateRunningTasks();
  });

  it("registers a task and retrieves it", () => {
    const task = makeTask();
    processSupervisor.registerTask(task);

    expect(processSupervisor.getTask(task.id)).toBe(task);
  });

  it("lists running and finished tasks separately", () => {
    const running = makeTask();
    const finished = makeTask({ status: "done", finishedAt: new Date() });
    processSupervisor.registerTask(running);
    processSupervisor.registerTask(finished);

    const list = processSupervisor.listTasks();
    expect(list.running.map((t) => t.id)).toContain(running.id);
    expect(list.finished.map((t) => t.id)).toContain(finished.id);
  });

  it("counts running tasks by type", () => {
    const browser = makeTask();
    processSupervisor.registerTask(browser);
    expect(processSupervisor.countRunningTasks("browser")).toBeGreaterThanOrEqual(1);
  });

  it("status transitions: running → done, error, stopped", () => {
    const done = makeTask();
    const errored = makeTask();
    const stopped = makeTask();
    processSupervisor.registerTask(done);
    processSupervisor.registerTask(errored);
    processSupervisor.registerTask(stopped);

    done.status = "done";
    done.summary = "Ziel erreicht";
    errored.status = "error";
    errored.summary = "boom";
    stopped.status = "stopped";

    expect(processSupervisor.getTask(done.id)?.status).toBe("done");
    expect(processSupervisor.getTask(errored.id)?.status).toBe("error");
    expect(processSupervisor.getTask(stopped.id)?.status).toBe("stopped");
  });

  it("stop() is callable and leaves status to the caller", () => {
    let stopped = false;
    const task = makeTask({ stop: () => { stopped = true; } });
    processSupervisor.registerTask(task);

    task.stop();
    expect(stopped).toBe(true);
  });

  it("completeTasksOnRestart marks running tasks as error: daemon restart", () => {
    let stopCalled = false;
    const running = makeTask({ stop: () => { stopCalled = true; } });
    const done = makeTask({ status: "done", finishedAt: new Date() });
    processSupervisor.registerTask(running);
    processSupervisor.registerTask(done);

    processSupervisor.completeTasksOnRestart();

    expect(processSupervisor.getTask(running.id)?.status).toBe("error");
    expect(processSupervisor.getTask(running.id)?.summary).toBe("daemon restart");
    expect(stopCalled).toBe(true);
    // Finished tasks are untouched.
    expect(processSupervisor.getTask(done.id)?.status).toBe("done");
  });

  it("task registry does not disturb process sessions", () => {
    const task = makeTask();
    processSupervisor.registerTask(task);

    // Process session APIs remain functional (no sessions registered here).
    expect(processSupervisor.list().running).toEqual([]);
    expect(processSupervisor.get("bg_deadbeef")).toBeUndefined();
    expect(processSupervisor.getTask(task.id)).toBe(task);
  });
});
