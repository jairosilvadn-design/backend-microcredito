import { Prisma } from '@prisma/client';

export const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
export const ZERO = D(0);
export const minDec = (a: Prisma.Decimal, b: Prisma.Decimal) => (a.lessThan(b) ? a : b);
