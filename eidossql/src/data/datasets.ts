// The embedded course dataset: a referentially-intact slice of Parch & Posey
// (the class teaching database), trimmed so every row stays visible on screen.
// To work with a full-size database, use “Connect your own Postgres” instead.

export type ColType = 'integer' | 'numeric' | 'text' | 'timestamp' | 'date' | 'boolean';
export interface ColumnDef { name: string; type: ColType }
export interface TableData {
  name: string;
  columns: ColumnDef[];
  rows: (string | number | boolean | null)[][];
  /** row count in the source database, when larger than the loaded sample */
  totalRows?: number;
}
export interface Dataset {
  id: string;
  label: string;
  description: string;
  tables: TableData[];
  source?: 'embedded' | 'postgres';
}

export const parch: Dataset = {
  id: 'parch',
  label: 'Parch & Posey (paper co.)',
  description: 'The class database: accounts, orders, sales reps, regions, and web events for a paper company. Trimmed to a small, fully-linked sample so every row stays visible.',
  source: 'embedded',
  tables: [
    {
      name: 'region',
      columns: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'text' }],
      rows: [
        [1, "Northeast"],
        [2, "Midwest"],
        [3, "Southeast"],
        [4, "West"],
        [5, "International"],
        [6, "South"],
        [7, "North"],
      ],
    },
    {
      name: 'sales_reps',
      columns: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'text' }, { name: 'region_id', type: 'integer' }],
      rows: [
        [321500, "Samuel Racine", 1],
        [321510, "Eugena Esser", 1],
        [321520, "Michel Averette", 1],
        [321740, "Charles Bidwell", 2],
        [321820, "Dorotha Seawell", 3],
        [321890, "Nelle Meaux", 3],
        [321900, "Soraya Fulton", 4],
        [321960, "Maryanna Fiorentino", 4],
        [321990, "Dawna Agnew", 4],
        [321991, "Alina Shein", 5],
      ],
    },
    {
      name: 'accounts',
      columns: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'text' }, { name: 'website', type: 'text' }, { name: 'primary_poc', type: 'text' }, { name: 'sales_rep_id', type: 'integer' }],
      rows: [
        [1001, "Walmart", "www.walmart.com", "Tamara Tuma", 321500],
        [1011, "Exxon Mobil", "www.exxonmobil.com", "Sung Shields", 321510],
        [1021, "Apple", "www.apple.com", "Jodee Lupo", 321520],
        [1036, "Mattel", "www.mattel.com", "Terrilyn Kesler", 321500],
        [2091, "Qualcomm", "www.qualcomm.com", "Torri Northrop", 321740],
        [2451, "Starbucks", "www.starbucks.com", "David Trousdale", 321740],
        [2761, "Gap", "www.gapinc.com", "Caprice Hohler", 321820],
        [3031, "Visa", "www.visa.com", "Madlyn Brothers", 321890],
        [3061, "Kellogg", "www.kelloggcompany.com", "Domonique Cave", 321820],
        [3601, "Estee Lauder", "www.elcompanies.com", "Grover Chamblee", 321900],
        [3991, "eBay", "www.ebay.com", "Monet Maclaren", 321990],
        [4061, "PayPal Holdings", "www.paypal.com", "Birgit Lacasse", 321960],
      ],
    },
    {
      name: 'orders',
      columns: [{ name: 'id', type: 'integer' }, { name: 'account_id', type: 'integer' }, { name: 'occurred_at', type: 'timestamp' }, { name: 'standard_qty', type: 'integer' }, { name: 'gloss_qty', type: 'integer' }, { name: 'poster_qty', type: 'integer' }, { name: 'total', type: 'integer' }, { name: 'standard_amt_usd', type: 'numeric' }, { name: 'gloss_amt_usd', type: 'numeric' }, { name: 'poster_amt_usd', type: 'numeric' }, { name: 'total_amt_usd', type: 'numeric' }],
      rows: [
        [1, 1001, "2015-10-06 17:31:14", 123, 22, 24, 169, 613.77, 164.78, 194.88, 973.43],
        [4313, 1001, "2016-05-01 15:40:04", 483, 570, 201, 1254, 2410.17, 4269.3, 1632.12, 8311.59],
        [16, 1001, "2016-12-24 05:53:13", 123, 127, 19, 269, 613.77, 951.23, 154.28, 1719.28],
        [17, 1011, "2016-12-21 10:59:34", 527, 14, 0, 541, 2629.73, 104.86, 0.0, 2734.59],
        [18, 1021, "2015-10-12 02:21:56", 516, 23, 0, 539, 2574.84, 172.27, 0.0, 2747.11],
        [20, 1021, "2015-12-11 16:53:18", 483, 0, 21, 504, 2410.17, 0.0, 170.52, 2580.69],
        [23, 1021, "2016-03-10 00:38:52", 555, 19, 4, 578, 2769.45, 142.31, 32.48, 2944.24],
        [1475, 2091, "2015-11-15 11:20:02", 494, 31, 0, 525, 2465.06, 232.19, 0.0, 2697.25],
        [1482, 2091, "2016-06-10 01:52:26", 431, 0, 0, 431, 2150.69, 0.0, 0.0, 2150.69],
        [1489, 2091, "2016-12-31 07:47:17", 465, 9, 611, 1085, 2320.35, 67.41, 4961.32, 7349.08],
        [1912, 2451, "2016-12-18 20:11:26", 280, 69, 20, 369, 1397.2, 516.81, 162.4, 2076.41],
        [5480, 2451, "2016-12-18 20:23:38", 48, 558, 1032, 1638, 239.52, 4179.42, 8379.84, 12798.78],
        [2353, 2761, "2016-10-12 19:29:02", 319, 31, 10, 360, 1591.81, 232.19, 81.2, 1905.2],
        [5752, 2761, "2016-11-11 13:25:38", 52, 465, 283, 800, 259.48, 3482.85, 2297.96, 6040.29],
        [2355, 2761, "2016-12-10 16:34:50", 0, 0, 7, 7, 0.0, 0.0, 56.84, 56.84],
        [2672, 3031, "2016-04-12 00:15:35", 649, 2, 23, 674, 3238.51, 14.98, 186.76, 3440.25],
        [2676, 3031, "2016-09-06 14:50:02", 343, 21, 28, 392, 1711.57, 157.29, 227.36, 2096.22],
        [2680, 3031, "2017-01-01 08:34:38", 299, 0, 9, 308, 1492.01, 0.0, 73.08, 1565.09],
        [2730, 3061, "2015-02-06 11:56:14", 495, 10, 39, 544, 2470.05, 74.9, 316.68, 2861.63],
        [2741, 3061, "2015-12-29 04:57:41", 516, 3, 0, 519, 2574.84, 22.47, 0.0, 2597.31],
        [2753, 3061, "2016-12-15 20:36:03", 505, 13, 130, 648, 2519.95, 97.37, 1055.6, 3672.92],
        [6346, 3601, "2016-08-21 04:03:47", 77, 466, 269, 812, 384.23, 3490.34, 2184.28, 6058.85],
        [6348, 3601, "2016-10-18 22:13:56", 68, 488, 306, 862, 339.32, 3655.12, 2484.72, 6479.16],
        [3383, 3601, "2016-12-16 17:26:44", 315, 45, 14, 374, 1571.85, 337.05, 113.68, 2022.58],
        [3680, 3991, "2015-02-09 04:13:11", 480, 0, 19, 499, 2395.2, 0.0, 154.28, 2549.48],
        [6524, 3991, "2015-12-31 13:29:55", 0, 0, 52, 52, 0.0, 0.0, 422.24, 422.24],
        [3703, 3991, "2016-12-17 01:26:49", 437, 16, 1014, 1467, 2180.63, 119.84, 8233.68, 10534.15],
        [3746, 4061, "2014-12-16 21:21:11", 529, 0, 1, 530, 2639.71, 0.0, 8.12, 2647.83],
        [6563, 4061, "2016-01-06 04:14:25", 0, 44, 21, 65, 0.0, 329.56, 170.52, 500.08],
        [3771, 4061, "2016-12-28 23:49:29", 460, 19, 6, 485, 2295.4, 142.31, 48.72, 2486.43],
      ],
    },
    {
      name: 'web_events',
      columns: [{ name: 'id', type: 'integer' }, { name: 'account_id', type: 'integer' }, { name: 'occurred_at', type: 'timestamp' }, { name: 'channel', type: 'text' }],
      rows: [
        [4394, 1001, "2015-10-06 04:22:11", "facebook"],
        [4406, 1001, "2016-05-01 14:26:40", "direct"],
        [16, 1001, "2016-12-24 05:35:14", "direct"],
        [4418, 1011, "2016-12-21 05:47:06", "facebook"],
        [17, 1011, "2016-12-21 10:29:36", "direct"],
        [4417, 1011, "2016-12-21 16:14:29", "adwords"],
        [18, 1021, "2015-10-12 02:10:54", "direct"],
        [4429, 1021, "2016-03-17 07:43:59", "twitter"],
        [4446, 1021, "2017-01-01 02:56:41", "organic"],
        [5984, 2091, "2015-11-15 02:19:03", "direct"],
        [5992, 2091, "2016-06-25 08:52:16", "banner"],
        [1525, 2091, "2016-12-31 07:20:22", "direct"],
        [6469, 2451, "2016-12-18 07:41:07", "facebook"],
        [1959, 2451, "2016-12-18 20:03:10", "direct"],
        [6884, 2761, "2016-10-12 08:06:51", "adwords"],
        [6885, 2761, "2016-11-07 10:51:52", "twitter"],
        [2411, 2761, "2016-12-10 16:08:05", "direct"],
        [7286, 3031, "2016-04-11 18:14:15", "organic"],
        [2734, 3031, "2016-09-06 14:22:44", "direct"],
        [2738, 3031, "2017-01-01 08:29:39", "direct"],
        [2788, 3061, "2015-02-06 11:39:41", "direct"],
        [7384, 3061, "2015-12-20 02:28:41", "direct"],
        [7402, 3061, "2016-12-25 14:38:11", "adwords"],
        [3448, 3601, "2016-08-21 03:43:18", "direct"],
        [7984, 3601, "2016-10-23 05:56:24", "twitter"],
        [7987, 3601, "2016-12-22 13:44:54", "adwords"],
        [3757, 3991, "2015-02-09 03:58:01", "direct"],
        [8340, 3991, "2015-12-08 16:53:21", "facebook"],
        [3780, 3991, "2016-12-17 00:56:29", "direct"],
        [8405, 4061, "2014-12-16 12:06:08", "banner"],
        [3838, 4061, "2016-01-06 04:00:46", "direct"],
        [3850, 4061, "2016-12-28 23:23:53", "direct"],
      ],
    },
  ],
};

export const datasets: Dataset[] = [parch];
