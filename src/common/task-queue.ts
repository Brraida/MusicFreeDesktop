/** Bound open files/metadata decoders without changing result order. */
export default class TaskQueue {
    private active = 0;
    private pending: Array<() => void> = [];
    private cursor = 0;

    constructor(private concurrency = 64) {}

    run<T>(task: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.pending.push(() => {
                ++this.active;
                Promise.resolve().then(task).then(resolve, reject).finally(() => {
                    --this.active;
                    this.drain();
                });
            });
            this.drain();
        });
    }

    private drain() {
        while (this.active < this.concurrency && this.cursor < this.pending.length) {
            this.pending[this.cursor++]();
        }
        if (this.cursor === this.pending.length) {
            this.pending = [];
            this.cursor = 0;
        }
    }
}
