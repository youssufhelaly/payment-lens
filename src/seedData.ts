import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ID_PATTERNS } from "./tools/registry";

export const SEED_FILE = "data/scenarios.json";

const SeededDataSchema = z.object({
  createdAt: z.string(),
  runId: z.string(),
  customers: z.object({
    acme: z.string().regex(ID_PATTERNS.customer),
    globex: z.string().regex(ID_PATTERNS.customer),
    initech: z.string().regex(ID_PATTERNS.customer),
  }),
  scenarios: z.array(
    z.object({
      id: z.string(),
      paymentIntentId: z.string().regex(ID_PATTERNS.paymentIntent),
      customerId: z.string().regex(ID_PATTERNS.customer),
      status: z.string(),
    }),
  ),
});

export type SeededData = z.infer<typeof SeededDataSchema>;

export async function loadSeedData(): Promise<SeededData> {
  let text: string;
  try {
    text = await readFile(SEED_FILE, "utf8");
  } catch {
    throw new Error(`${SEED_FILE} not found. Run "npm run seed" first.`);
  }
  return SeededDataSchema.parse(JSON.parse(text));
}

export async function saveSeedData(data: SeededData): Promise<void> {
  await mkdir(dirname(SEED_FILE), { recursive: true });
  await writeFile(SEED_FILE, `${JSON.stringify(SeededDataSchema.parse(data), null, 2)}\n`);
}
