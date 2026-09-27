import type { Detector } from '../types.ts'
import { cacheNeverRead } from './cache-never-read.ts'
import { prefixInvalidated } from './prefix-invalidated.ts'
import { ttlPremiumWasted } from './ttl-premium-wasted.ts'
import { cachingNetNegative } from './caching-net-negative.ts'

export const detectors: Detector[] = [
  cacheNeverRead,
  prefixInvalidated,
  ttlPremiumWasted,
  cachingNetNegative,
]
