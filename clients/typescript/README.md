# TypeScript API client

`generated/api.ts` is produced from [`openapi/openapi.yaml`](../../openapi/openapi.yaml) with
[`oazapfts`](https://www.npmjs.com/package/oazapfts). Do not edit it by hand.

```bash
npm run api:generate   # regenerate after changing the contract
npm run api:check      # lint the contract and typecheck the client
```

Example:

```ts
import { createBooking, defaults } from './generated/api.js';

defaults.baseUrl = 'http://localhost:3000';
defaults.headers.Authorization = `Bearer ${accessToken}`;
defaults.headers['X-Request-Id'] = crypto.randomUUID();

const consultation = await createBooking(crypto.randomUUID(), {
  slotId: '0198f3f0-0000-7000-8000-000000000000',
});
```

The generated client exports schema types (for example `Consultation`, `Payment`, and
`Prescription`) alongside one function per OpenAPI operation.
