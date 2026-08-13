export class TaskActivityTracker {
  private readonly activity = new Map<string, number>();

  touch(sessionID: string, now = Date.now()): void {
    if (sessionID) this.activity.set(sessionID, now);
  }

  lastActivityAt(sessionID: string): number | undefined {
    return this.activity.get(sessionID);
  }

  forget(sessionID: string): void {
    this.activity.delete(sessionID);
  }
}
