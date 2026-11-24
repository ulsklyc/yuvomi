/**
 * Alle Migrationen in Laufreihenfolge, eine Datei je Version (server/migrations/NNNN.ts).
 * Neue Migrationen nur am ENDE anhaengen (Import und Arrayzeile); bestehende nie
 * aendern, umsortieren oder neu nummerieren - test:migrations-append-only haelt das.
 */

import m0001 from './0001.ts';
import m0002 from './0002.ts';
import m0003 from './0003.ts';
import m0004 from './0004.ts';
import m0005 from './0005.ts';
import m0006 from './0006.ts';
import m0007 from './0007.ts';
import m0008 from './0008.ts';
import m0009 from './0009.ts';
import m0010 from './0010.ts';
import m0011 from './0011.ts';
import m0012 from './0012.ts';
import m0013 from './0013.ts';
import m0014 from './0014.ts';
import m0015 from './0015.ts';
import m0016 from './0016.ts';
import m0017 from './0017.ts';
import m0018 from './0018.ts';
import m0019 from './0019.ts';
import m0020 from './0020.ts';
import m0021 from './0021.ts';
import m0022 from './0022.ts';
import m0023 from './0023.ts';
import m0024 from './0024.ts';
import m0025 from './0025.ts';
import m0026 from './0026.ts';
import m0027 from './0027.ts';
import m0028 from './0028.ts';
import m0029 from './0029.ts';
import m0030 from './0030.ts';
import m0031 from './0031.ts';
import m0032 from './0032.ts';
import m0033 from './0033.ts';
import m0034 from './0034.ts';
import m0035 from './0035.ts';
import m0036 from './0036.ts';
import m0037 from './0037.ts';
import m0038 from './0038.ts';
import m0039 from './0039.ts';
import m0040 from './0040.ts';
import m0041 from './0041.ts';
import m0042 from './0042.ts';
import m0043 from './0043.ts';
import m0044 from './0044.ts';
import m0045 from './0045.ts';
import m0046 from './0046.ts';
import m0047 from './0047.ts';
import m0048 from './0048.ts';
import m0049 from './0049.ts';
import m0050 from './0050.ts';
import m0051 from './0051.ts';
import m0052 from './0052.ts';
import m0053 from './0053.ts';
import m0054 from './0054.ts';
import m0055 from './0055.ts';
import m0056 from './0056.ts';
import m0057 from './0057.ts';
import m0058 from './0058.ts';
import m0059 from './0059.ts';
import m0060 from './0060.ts';
import m0061 from './0061.ts';
import m0062 from './0062.ts';
import m0063 from './0063.ts';
import m0064 from './0064.ts';
import m0065 from './0065.ts';
import m0066 from './0066.ts';
import m0067 from './0067.ts';
import m0068 from './0068.ts';
import m0069 from './0069.ts';
import m0070 from './0070.ts';
import m0071 from './0071.ts';
import m0072 from './0072.ts';
import m0073 from './0073.ts';
import m0074 from './0074.ts';
import m0075 from './0075.ts';
import m0076 from './0076.ts';
import m0077 from './0077.ts';
import m0078 from './0078.ts';
import m0079 from './0079.ts';
import m0080 from './0080.ts';
import m0081 from './0081.ts';
import m0082 from './0082.ts';
import m0083 from './0083.ts';
import m0084 from './0084.ts';
import m0085 from './0085.ts';
import m0086 from './0086.ts';
import m0087 from './0087.ts';
import m0088 from './0088.ts';
import m0089 from './0089.ts';
import m0090 from './0090.ts';
import m0091 from './0091.ts';
import m0092 from './0092.ts';
import m0093 from './0093.ts';
import m0094 from './0094.ts';
import m0095 from './0095.ts';
import m0096 from './0096.ts';
import m0097 from './0097.ts';
import m0098 from './0098.ts';
import m0099 from './0099.ts';
import m0100 from './0100.ts';
import m0101 from './0101.ts';
import m0102 from './0102.ts';
import m0103 from './0103.ts';
import m0104 from './0104.ts';
import m0105 from './0105.ts';
import m0106 from './0106.ts';
import m0107 from './0107.ts';
import m0108 from './0108.ts';
import m0109 from './0109.ts';
import m0110 from './0110.ts';
import m0111 from './0111.ts';
import m0112 from './0112.ts';
import m0113 from './0113.ts';
import m0114 from './0114.ts';
import m0115 from './0115.ts';
import m0116 from './0116.ts';
import m0117 from './0117.ts';
import m0118 from './0118.ts';
import m0119 from './0119.ts';
import m0120 from './0120.ts';
import m0121 from './0121.ts';
import m0122 from './0122.ts';
import m0123 from './0123.ts';
import m0124 from './0124.ts';
import m0125 from './0125.ts';
import m0126 from './0126.ts';
import m0127 from './0127.ts';
import m0128 from './0128.ts';
import m0129 from './0129.ts';
import m0130 from './0130.ts';
import m0131 from './0131.ts';
import m0132 from './0132.ts';
import m0133 from './0133.ts';
import m0134 from './0134.ts';
import m0135 from './0135.ts';
import m0136 from './0136.ts';
import m0137 from './0137.ts';
import m0138 from './0138.ts';
import m0139 from './0139.ts';
import m0140 from './0140.ts';
import m0141 from './0141.ts';
import m0142 from './0142.ts';
import m0143 from './0143.ts';
import m0144 from './0144.ts';
import m0145 from './0145.ts';
import m0146 from './0146.ts';
import m0147 from './0147.ts';
import m0148 from './0148.ts';
import m0149 from './0149.ts';
import m0150 from './0150.ts';
import m0151 from './0151.ts';
import m0152 from './0152.ts';
import m0153 from './0153.ts';
import m0154 from './0154.ts';
import m0155 from './0155.ts';
import m0156 from './0156.ts';
import m0157 from './0157.ts';
import m0158 from './0158.ts';
import m0159 from './0159.ts';
import m0160 from './0160.ts';
import m0161 from './0161.ts';
import m0162 from './0162.ts';
import m0163 from './0163.ts';
import m0164 from './0164.ts';
import m0165 from './0165.ts';
import m0166 from './0166.ts';
import m0167 from './0167.ts';
import m0168 from './0168.ts';
import m0169 from './0169.ts';
import m0170 from './0170.ts';
import m0171 from './0171.ts';
import m0172 from './0172.ts';
import m0173 from './0173.ts';
import m0174 from './0174.ts';
import m0175 from './0175.ts';
import m0176 from './0176.ts';
import m0177 from './0177.ts';
import m0178 from './0178.ts';
import m0179 from './0179.ts';
import m0180 from './0180.ts';
import m0181 from './0181.ts';
import m0182 from './0182.ts';
import m0183 from './0183.ts';
import m0184 from './0184.ts';
import m0185 from './0185.ts';
import m0186 from './0186.ts';
import m0187 from './0187.ts';
import m0188 from './0188.ts';
import m0189 from './0189.ts';
import m0190 from './0190.ts';
import m0191 from './0191.ts';
import m0192 from './0192.ts';
import m0193 from './0193.ts';
import m0194 from './0194.ts';
import m0195 from './0195.ts';
import m0196 from './0196.ts';
import m0197 from './0197.ts';
import m0198 from './0198.ts';
import m0199 from './0199.ts';
import m0200 from './0200.ts';
import m0201 from './0201.ts';
import m0202 from './0202.ts';
import m0203 from './0203.ts';
import m0204 from './0204.ts';
import m0205 from './0205.ts';
import m0206 from './0206.ts';
import m0207 from './0207.ts';
import m0208 from './0208.ts';
import m0209 from './0209.ts';
import m0210 from './0210.ts';
import m0211 from './0211.ts';
import m0212 from './0212.ts';
import m0213 from './0213.ts';
import m0214 from './0214.ts';
import m0215 from './0215.ts';
import m0216 from './0216.ts';
import m0217 from './0217.ts';
import m0218 from './0218.ts';
import m0219 from './0219.ts';
import m0220 from './0220.ts';
import m0221 from './0221.ts';
import m0222 from './0222.ts';
import m0223 from './0223.ts';
import m0224 from './0224.ts';
import m0225 from './0225.ts';
import m0226 from './0226.ts';
import m0227 from './0227.ts';
import m0228 from './0228.ts';
import m0229 from './0229.ts';
import m0230 from './0230.ts';
import m0231 from './0231.ts';
import m0232 from './0232.ts';
import m0233 from './0233.ts';
import m0234 from './0234.ts';
import m0235 from './0235.ts';
import m0236 from './0236.ts';
import m0237 from './0237.ts';
import m0238 from './0238.ts';
import m0239 from './0239.ts';
import m0240 from './0240.ts';
import m0241 from './0241.ts';
import m0242 from './0242.ts';
import m0243 from './0243.ts';
import m0244 from './0244.ts';
import m0245 from './0245.ts';
import m0246 from './0246.ts';
import m0247 from './0247.ts';
import m0248 from './0248.ts';
import m0249 from './0249.ts';
import m0250 from './0250.ts';
import m0251 from './0251.ts';
import m0252 from './0252.ts';
import m0253 from './0253.ts';
import m0254 from './0254.ts';
import m0255 from './0255.ts';
import m0256 from './0256.ts';
import m0257 from './0257.ts';
import m0258 from './0258.ts';
import m0259 from './0259.ts';
import m0260 from './0260.ts';
import m0261 from './0261.ts';
import m0262 from './0262.ts';
import m0263 from './0263.ts';
import m0264 from './0264.ts';
import m0265 from './0265.ts';
import m0266 from './0266.ts';
import m0267 from './0267.ts';
import m0268 from './0268.ts';
import m0269 from './0269.ts';
import m0270 from './0270.ts';
import m0271 from './0271.ts';
import m0272 from './0272.ts';
import m0273 from './0273.ts';
import m0274 from './0274.ts';
import m0275 from './0275.ts';
import m0276 from './0276.ts';
import m0277 from './0277.ts';
import m0278 from './0278.ts';
import m0279 from './0279.ts';
import m0280 from './0280.ts';
import m0281 from './0281.ts';
import m0282 from './0282.ts';
import m0283 from './0283.ts';
import m0284 from './0284.ts';

export const MIGRATIONS = [
  m0001,
  m0002,
  m0003,
  m0004,
  m0005,
  m0006,
  m0007,
  m0008,
  m0009,
  m0010,
  m0011,
  m0012,
  m0013,
  m0014,
  m0015,
  m0016,
  m0017,
  m0018,
  m0019,
  m0020,
  m0021,
  m0022,
  m0023,
  m0024,
  m0025,
  m0026,
  m0027,
  m0028,
  m0029,
  m0030,
  m0031,
  m0032,
  m0033,
  m0034,
  m0035,
  m0036,
  m0037,
  m0038,
  m0039,
  m0040,
  m0041,
  m0042,
  m0043,
  m0044,
  m0045,
  m0046,
  m0047,
  m0048,
  m0049,
  m0050,
  m0051,
  m0052,
  m0053,
  m0054,
  m0055,
  m0056,
  m0057,
  m0058,
  m0059,
  m0060,
  m0061,
  m0062,
  m0063,
  m0064,
  m0065,
  m0066,
  m0067,
  m0068,
  m0069,
  m0070,
  m0071,
  m0072,
  m0073,
  m0074,
  m0075,
  m0076,
  m0077,
  m0078,
  m0079,
  m0080,
  m0081,
  m0082,
  m0083,
  m0084,
  m0085,
  m0086,
  m0087,
  m0088,
  m0089,
  m0090,
  m0091,
  m0092,
  m0093,
  m0094,
  m0095,
  m0096,
  m0097,
  m0098,
  m0099,
  m0100,
  m0101,
  m0102,
  m0103,
  m0104,
  m0105,
  m0106,
  m0107,
  m0108,
  m0109,
  m0110,
  m0111,
  m0112,
  m0113,
  m0114,
  m0115,
  m0116,
  m0117,
  m0118,
  m0119,
  m0120,
  m0121,
  m0122,
  m0123,
  m0124,
  m0125,
  m0126,
  m0127,
  m0128,
  m0129,
  m0130,
  m0131,
  m0132,
  m0133,
  m0134,
  m0135,
  m0136,
  m0137,
  m0138,
  m0139,
  m0140,
  m0141,
  m0142,
  m0143,
  m0144,
  m0145,
  m0146,
  m0147,
  m0148,
  m0149,
  m0150,
  m0151,
  m0152,
  m0153,
  m0154,
  m0155,
  m0156,
  m0157,
  m0158,
  m0159,
  m0160,
  m0161,
  m0162,
  m0163,
  m0164,
  m0165,
  m0166,
  m0167,
  m0168,
  m0169,
  m0170,
  m0171,
  m0172,
  m0173,
  m0174,
  m0175,
  m0176,
  m0177,
  m0178,
  m0179,
  m0180,
  m0181,
  m0182,
  m0183,
  m0184,
  m0185,
  m0186,
  m0187,
  m0188,
  m0189,
  m0190,
  m0191,
  m0192,
  m0193,
  m0194,
  m0195,
  m0196,
  m0197,
  m0198,
  m0199,
  m0200,
  m0201,
  m0202,
  m0203,
  m0204,
  m0205,
  m0206,
  m0207,
  m0208,
  m0209,
  m0210,
  m0211,
  m0212,
  m0213,
  m0214,
  m0215,
  m0216,
  m0217,
  m0218,
  m0219,
  m0220,
  m0221,
  m0222,
  m0223,
  m0224,
  m0225,
  m0226,
  m0227,
  m0228,
  m0229,
  m0230,
  m0231,
  m0232,
  m0233,
  m0234,
  m0235,
  m0236,
  m0237,
  m0238,
  m0239,
  m0240,
  m0241,
  m0242,
  m0243,
  m0244,
  m0245,
  m0246,
  m0247,
  m0248,
  m0249,
  m0250,
  m0251,
  m0252,
  m0253,
  m0254,
  m0255,
  m0256,
  m0257,
  m0258,
  m0259,
  m0260,
  m0261,
  m0262,
  m0263,
  m0264,
  m0265,
  m0266,
  m0267,
  m0268,
  m0269,
  m0270,
  m0271,
  m0272,
  m0273,
  m0274,
  m0275,
  m0276,
  m0277,
  m0278,
  m0279,
  m0280,
  m0281,
  m0282,
  m0283,
  m0284,
];
