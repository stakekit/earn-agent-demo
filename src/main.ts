import * as dotenv from "dotenv";
import OpenAI from "openai";
import "cross-fetch/polyfill";
import Enquirer from "enquirer";
import { HDNodeWallet, Wallet } from "ethers";

dotenv.config();

const CHECK_INTERVAL = 5 * 60_000;
const NETWORK = "arbitrum" as any;
const BASE_URL = "https://api.stakek.it";
const STAKEKIT_API_KEY = process.env.STAKEKIT_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MNEMONIC = process.env.MNEMONIC || "";
let earnAgentBusy = false;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

async function get(path: string): Promise<any> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": STAKEKIT_API_KEY,
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status}`);
  }
  return response.json();
}

async function post(path: string, body: any): Promise<any> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": STAKEKIT_API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${path} failed: ${response.status}`);
  }
  return response.json();
}

async function patch(path: string, body: any): Promise<any> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": STAKEKIT_API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`PATCH ${path} failed: ${response.status}`);
  }
  return response.json();
}

interface YieldOpportunity {
  id: string;
  apy: number;
  token: {
    address?: string;
    symbol: string;
  };
  metadata: {
    name: string;
    cooldownPeriod?: { days: number };
    warmupPeriod?: { days: number };
    withdrawPeriod?: { days: number };
  };
  status: {
    enter: boolean;
    exit: boolean;
  };
}

interface EarningPosition {
  integrationId: string;
  amount: string;
}

interface EarnAgentOp {
  steps: {
    type: "ENTER" | "EXIT";
    integrationId: string;
    amount?: string;
  }[];
}

const earnAgentData = {
  yields: [] as YieldOpportunity[],
  earningPositions: [] as EarningPosition[],
  idleTokenBalances: {} as Record<string, string>,
};

async function main() {
  console.log("Earn Agent started.");

  const wallet = Wallet.fromPhrase(MNEMONIC);
  const address = await wallet.getAddress();

  console.log(`Earn Agent => using address: ${address}`);

  await refreshEarnAgentData(address);

  setInterval(async () => {
    if (earnAgentBusy) {
      console.log("Earn Agent is busy; skipping interval check...");
      return;
    }
    earnAgentBusy = true;
    try {
      await refreshEarnAgentData(address);
      await earnAgentIntervalCheck(wallet);
    } catch (err) {
      console.error("Earn Agent interval check error =>", err);
    } finally {
      earnAgentBusy = false;
    }
  }, CHECK_INTERVAL);

  earnAgentBusy = true;
  try {
    await earnAgentIntervalCheck(wallet);
  } catch (err) {
    console.error("Initial check error =>", err);
  } finally {
    earnAgentBusy = false;
  }

  while (true) {
    const { userMsg } = await Enquirer.prompt<{ userMsg: string }>({
      type: "input",
      name: "userMsg",
      message: "You:",
    });

    if (earnAgentBusy) {
      console.log("Earn Agent is busy; please wait...");
      continue;
    }
    earnAgentBusy = true;
    try {
      await handleChat(userMsg, wallet);
    } catch (err) {
      console.error("Chat error =>", err);
    } finally {
      earnAgentBusy = false;
    }
  }
}

async function earnAgentIntervalCheck(wallet: HDNodeWallet) {
  console.log("\n🔄 earnAgentIntervalCheck => scanning for single scenario improvement...");

  await refreshEarnAgentData(await wallet.getAddress());

  await runAiScenario(
    `
Speak conversationally. If a yield is underperforming, do an EXIT followed by an ENTER. 
If user has idle tokens, do ENTER. 
If no changes, produce {}.
`,
    "Do we have a single scenario improvement right now?",
    wallet
  );
}

async function handleChat(userMsg: string, wallet: HDNodeWallet) {
  await runAiScenario(
    `
User might ask about their positions or idle tokens. 
They might request an EXIT or deposit idle tokens. 
If yield is underperforming => do EXIT+ENTER. 
If no improvement => {}.
Focus on DeFi or crypto.
`,
    userMsg,
    wallet
  );
}

async function runAiScenario(systemInstructions: string, userMsg: string, wallet: HDNodeWallet) {
  const systemPrompt = buildSystemPrompt(systemInstructions);

  const chatResp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMsg },
    ],
    temperature: 0.2,
  });

  const rawAiText = chatResp.choices[0].message?.content || "";

  console.log("\nEarn Agent:\n");
  console.log(rawAiText.trim());
  console.log("");

  const op = parseOpFromCodeBlock(rawAiText);
  if (!op) {
    return false;
  }

  for (const step of op.steps) {
    await runScenarioStep(step.type, step.integrationId, wallet, step.amount);
  }
  return true;
}

function buildSystemPrompt(instructions: string): string {
  const dataSummary = earnAgentDataToString();
  return `
You are the Earn Agent, focusing on yield optimization in DeFi. 
Speak in a friendly, descriptive style, possibly with bullet points.

**Key Points**:
1. You must check **all** earning tokens (USDC, WETH, ARB, etc.) for potential improvements.
   - If a token's current yield is underperforming, propose an EXIT + ENTER (same token, no bridging/swaps).
   - If user has idle tokens, propose ENTER for that exact token if a better yield is available.
   - If user explicitly wants to withdraw from a yield, a single-step EXIT is allowed.
   - Always compare token address or symbol carefully to ensure correct token matching yield.
   - If no improvements for any token, produce an **empty object** "{}".
2. Multiple improvements in a single scenario are allowed (e.g., multiple EXIT+ENTER pairs), as long as each pair uses the same token.
3. No bridging or swapping. If bridging/swapping is required, produce "{}" or single-step EXIT if user specifically wants to withdraw.
4. **Metadata** requirement: 
   - Whenever you mention a yield or token in conversation, also provide relevant aggregator metadata if available (project name, short description, APY details). 
   - If a user asks about a token balance, it's easier to not respond with an address, but with the token symbol or name found in the yield.token field from the yields data
   - If aggregator data is incomplete, disclaim that you lack further details.
5. **Scenario Code Block**:
   - You must conclude your response **immediately** with exactly one code block of shape:
     \`\`\`json
     {
       "steps": [
         { "type": "ENTER"|"EXIT", "integrationId": "...", "amount"?: "..." }
       ]
     }
     \`\`\`
   - If no changes, return an empty object \`{}\` in that code block.
   - **Important**: Once you provide the code block, **do not** add any further text afterwards. End your response there.
   - No "description" field in the JSON, only "steps".

User aggregator data:
${dataSummary}

INSTRUCTIONS:
${instructions}
`;
}

function earnAgentDataToString(): string {
  let out = "Yields:\n";
  for (const y of earnAgentData.yields) {
    out += ` - ID: ${y.id}, name: ${y.metadata.name}, APY: ${(y.apy * 100).toFixed(2)}%, canEnter: ${y.status.enter}, canExit: ${y.status.exit}\n`;
  }
  out += "\nPositions:\n";
  for (const p of earnAgentData.earningPositions) {
    out += ` - integrationId: ${p.integrationId}, staked: ${p.amount}\n`;
  }
  out += "\nIdle Token Balances:\n";
  for (const [addr, amt] of Object.entries(earnAgentData.idleTokenBalances)) {
    out += ` - token: ${addr}, amount: ${amt}\n`;
  }
  return out;
}

function parseOpFromCodeBlock(aiText: string): EarnAgentOp | null {
  const scenarioRegex = /```json([\s\S]*?)```/;
  const match = scenarioRegex.exec(aiText);
  if (!match) {
    return null;
  }

  try {
    const opsObj = JSON.parse(match[1].trim());
    if (!Object.keys(opsObj).length) {
      return null; // empty => no improvements
    }
    if (!Array.isArray(opsObj.steps)) {
      console.log("Scenario JSON is missing 'steps' => skip scenario");
      return null;
    }
    return opsObj;
  } catch (err) {
    console.log("Failed to parse scenario =>", err);
    return null;
  }
}

async function runScenarioStep(
  type: "ENTER" | "EXIT",
  integrationId: string,
  wallet: HDNodeWallet,
  amount?: string
) {
  console.log(`\n[${type}] yield ${integrationId}, ${type === "ENTER" ? "deposit" : "withdraw"} ${amount || "???"}`);

  const address = await wallet.getAddress();
  let finalAmount = amount;

  if (!finalAmount) {
    if (type === "EXIT") {
      const posResp = await post(`/v1/yields/${integrationId}/balances`, { addresses: { address } });
      const staked = posResp.find((b: any) => b.type === "staked");
      if (!staked || parseFloat(staked.amount) <= 0) {
        console.log("No staked => skip EXIT");
        return;
      }
      finalAmount = staked.amount;
    } else {
      const details = await get(`/v2/yields/${integrationId}`);
      const tokenAddr = details.token?.address ?? "native";
      const balResp = await post(`/v1/tokens/balances`, {
        addresses: [{ network: NETWORK, address, ...(tokenAddr !== "native" && { tokenAddress: tokenAddr }) }],
      });
      const bal = balResp[0]?.amount || "0";
      if (parseFloat(bal) <= 0) {
        console.log("No balance => skip ENTER");
        return;
      }
      finalAmount = bal;
    }
  }

  const endpoint = type === "ENTER" ? "enter" : "exit";
  const session = await post(`/v1/actions/${endpoint}`, {
    integrationId,
    addresses: { address },
    args: { amount: finalAmount },
  });
  await processTransactions(session.transactions, wallet);

  console.log(`${type} done => yield ${integrationId}\n`);
  await refreshEarnAgentData(address);
}

async function processTransactions(transactions: any[], wallet: HDNodeWallet) {
  for (const tx of transactions) {
    if (tx.status === "SKIPPED") continue;

    console.log(`Earn Agent => TX => ${tx.type}`);
    let unsignedTx;
    for (let i = 0; i < 3; i++) {
      try {
        unsignedTx = await patch(`/v1/transactions/${tx.id}`, {});
        break;
      } catch (err) {
        console.log(`Attempt ${i + 1} => retrying...`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!unsignedTx) {
      console.log("Earn Agent => cannot construct TX => skip");
      continue;
    }

    const signedTx = await wallet.signTransaction(JSON.parse(unsignedTx.unsignedTransaction));
    const submitResult = await post(`/v1/transactions/${tx.id}/submit`, { signedTransaction: signedTx });
    console.log("Earn Agent => TX submitted =>", submitResult);

    while (true) {
      const status = await get(`/v1/transactions/${tx.id}/status`).catch(() => null);
      if (!status) {
        console.log("Earn Agent => no TX status => break");
        break;
      }
      if (status.status === "CONFIRMED") {
        console.log(`Earn Agent => TX confirmed => ${status.url}\n`);
        break;
      } else if (status.status === "FAILED") {
        console.log("Earn Agent => TX failed");
        break;
      } else {
        console.log("Earn Agent => TX pending...");
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
}

async function refreshEarnAgentData(address: string) {
  console.log("Earn Agent => refreshing data...");

  const allYields = await fetchAllYields();
  earnAgentData.yields = filterSortYields(allYields);
  earnAgentData.earningPositions = await fetchEarningPositions(earnAgentData.yields, address);
  earnAgentData.idleTokenBalances = await fetchUserBalances(earnAgentData.yields, address);
  console.log("Data refreshed.\n");
}

async function fetchAllYields(): Promise<YieldOpportunity[]> {
  const resp = await get(`/v2/yields?network=${NETWORK}`);
  const yields: YieldOpportunity[] = resp.data;
  return yields;
}

function filterSortYields(all: YieldOpportunity[]): YieldOpportunity[] {
  return all
    .filter((y) => {
      const noCooldown = !y.metadata.cooldownPeriod || y.metadata.cooldownPeriod.days === 0;
      const noWarmup = !y.metadata.warmupPeriod || y.metadata.warmupPeriod.days === 0;
      const noWithdraw = !y.metadata.withdrawPeriod || y.metadata.withdrawPeriod.days === 0;
      return y.status.enter && y.status.exit && noCooldown && noWarmup && noWithdraw;
    })
    .sort((a, b) => b.apy - a.apy);
}

async function fetchEarningPositions(
  yields: YieldOpportunity[],
  address: string
): Promise<EarningPosition[]> {
  const chunkSize = 15;
  const positions: EarningPosition[] = [];

  for (let i = 0; i < yields.length; i += chunkSize) {
    const chunk = yields.slice(i, i + chunkSize);

    const payload = chunk.map((y) => ({
      addresses: { address },
      integrationId: y.id,
    }));

    const resp = await post(`/v1/yields/balances`, payload);

    for (const item of resp) {
      const integrationId = item.integrationId;
      const staked = item.balances.find((b: any) => b.type === "staked");
      if (staked && parseFloat(staked.amount) > 0) {
        positions.push({
          integrationId,
          amount: staked.amount,
        });
      }
    }
  }

  return positions;
}

async function fetchUserBalances(yields: YieldOpportunity[], address: string): Promise<Record<string, string>> {
  const addrs = new Set<string | undefined>();
  for (const y of yields) {
    if (y.token?.address) {
      addrs.add(y.token.address);
    }
  }

  const payload: any[] = [];
  for (const addr of addrs) {
    if (!addr) {
      payload.push({ network: NETWORK, address });
    } else {
      payload.push({ network: NETWORK, address, tokenAddress: addr.toLowerCase() });
    }
  }

  const resp = await post(`/v1/tokens/balances`, { addresses: payload });
  const record: Record<string, string> = {};
  for (const b of resp) {
    if (parseFloat(b.amount) > 0) {
      if (!b.token.address) {
        record["native"] = b.amount;
      } else {
        record[b.token.address.toLowerCase()] = b.amount;
      }
    }
  }
  return record;
}

main().catch((err) => {
  console.error("Earn Agent stopped =>", err);
  process.exit(1);
});
