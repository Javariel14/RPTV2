import { mkdir, writeFile } from 'node:fs/promises';
import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';

/** Generated evidence only: deliberately excludes request headers and credentials. */
export default class U4Reporter implements Reporter {
  private readonly tests: Array<{
    title: string;
    status: string;
    durationMs: number;
    retry: number;
  }> = [];
  onTestEnd(test: TestCase, result: TestResult) {
    if (test.title.startsWith('U4 '))
      this.tests.push({
        title: test.title,
        status: result.status,
        durationMs: result.duration,
        retry: result.retry,
      });
  }
  async onEnd(result: FullResult) {
    await mkdir('work', { recursive: true });
    await writeFile(
      'work/u4-e2e-results.json',
      JSON.stringify(
        {
          schemaVersion: 1,
          suiteStatus: result.status,
          startedAt: result.startTime.toISOString(),
          durationMs: result.duration,
          tests: this.tests,
        },
        null,
        2,
      ),
    );
  }
}
