// Calgary's clock, for every page. Alberta stopped changing its clocks in 2026:
// Alberta Time (ABT) is UTC-6 all year, the clock it was already on at launch, so
// this holds for every moment the site shows. It is fixed here rather than asked of
// America/Edmonton because a browser with older time-zone data falls back to UTC-7
// from Nov 1, 2026, and up-to-date ones name the zone MDT or CST.
export const CALGARY_TIME_ZONE = 'Etc/GMT+6'; // the sign is POSIX's: this is UTC-6
export const CALGARY_ZONE_NAME = 'ABT';
