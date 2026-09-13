import { defineCloudflareConfig } from '@opennextjs/cloudflare';
// Fixture reference is dynamically rendered; no customer/tenant cache or R2 yet.
export default defineCloudflareConfig({});
