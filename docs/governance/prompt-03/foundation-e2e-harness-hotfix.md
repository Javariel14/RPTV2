# Foundation E2E harness hotfix (post-E2)

The root `test:e2e` command owns only `reference.spec.ts` and starts `npm run dev`.
Stateful suites use synthetic PostgreSQL, the CRM bridge, and a local session code through `npm run dev:crm`.

| Spec                                                                                                          | Config                           | Command                       |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------- |
| `reference.spec.ts`                                                                                           | `playwright.config.ts`           | `npm run test:e2e`            |
| `crm.spec.ts`, `crm-u4.spec.ts`, `crm-u5.spec.ts`, `crm-u6.spec.ts`, `crm-e1c3.spec.ts`, `e1-closure.spec.ts` | `tests/e2e/crm.config.ts`        | `npm run test:crm:e2e`        |
| `recruiting.spec.ts`                                                                                          | `tests/e2e/recruiting.config.ts` | `npm run test:recruiting:e2e` |
| `agenda.spec.ts`                                                                                              | `tests/e2e/agenda.config.ts`     | `npm run test:agenda:e2e`     |
| `field.spec.ts`                                                                                               | `tests/e2e/field.config.ts`      | `npm run test:field:e2e`      |

Foundation keeps the generic and CRM gates and adds dedicated Recruiting, Agenda, and Field gates. Each spec runs under one owning config; no suite is removed or run twice. This change does not alter application behavior or security policy.
