import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marks a route as intentionally reachable without a bearer token. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
