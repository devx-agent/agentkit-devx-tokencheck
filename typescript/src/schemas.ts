import { z } from "zod";
import { SUPPORTED_CHAINS } from "./tokencheck";

export const CheckTokenRiskSchema = z
  .object({
    tokenAddress: z.string().describe("Token contract address (0x... for EVM chains, base58 mint for Solana)"),
    chain: z
      .enum(SUPPORTED_CHAINS)
      .optional()
      .describe("Chain of the token. Defaults to the wallet's network if supported, else base."),
  })
  .strip()
  .describe("Check a token for rug/honeypot risk before buying it");

export const PreSwapCheckSchema = z
  .object({
    tokenAddress: z.string().describe("Address of the token you are about to buy / receive in a swap"),
    chain: z.enum(SUPPORTED_CHAINS).optional().describe("Chain of the token. Defaults to the wallet's network, else base."),
  })
  .strip()
  .describe("Decide whether a swap into this token should proceed");
