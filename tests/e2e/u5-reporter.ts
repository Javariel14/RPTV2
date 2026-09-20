import { mkdir, writeFile } from 'node:fs/promises';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

/** Generated evidence only: titles and timings contain no customer or session data. */
export default class U5Reporter implements Reporter {
  private readonly tests: Array<{
    title: string;
    status: string;
    durationMs: number;
    retry: number;
  }> = [];

  onTestEnd(test: TestCase, result: TestResult) {
    if (test.title.startsWith('U5 '))
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
      'work/u5-e2e-results.json',
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
