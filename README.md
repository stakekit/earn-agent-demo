# Earn Agent Demo

A proof-of-concept **autonomous** DeFi "Earn Agent" that checks yield opportunities on **Arbitrum** using [StakeKit](https://stakek.it/). It periodically scans for improvements to the user’s staked positions or idle balances, then queries **OpenAI** for **ENTER** or **EXIT** recommendations and **automatically executes** the resulting transactions on-chain.

## Features

- **Autonomous Rebalancing**: Every 5 minutes, the agent checks if a yield is underperforming or if you have idle tokens, then invokes OpenAI to propose ENTER/EXIT moves.
- **Automatic Transaction Execution**: Once the AI provides steps (ENTER or EXIT), the agent **signs** and **submits** the aggregator transactions using your wallet mnemonic.
- **Conversational Interface**: You can also prompt the agent via CLI to ask questions like “Should I exit any positions?” or “Is there a better APY for my USDC?”.

## Requirements

- [Node.js 16+](https://nodejs.org/)
- [pnpm](https://pnpm.io/)
- A [StakeKit API Key](https://stakek.it/)
- An [OpenAI API Key](https://platform.openai.com/)
- A valid mnemonic seed phrase for transaction signing

## Environment Variables

Create a `.env` file in the project root:

```
STAKEKIT_API_KEY=YOUR_STAKEKIT_API_KEY
OPENAI_API_KEY=YOUR_OPENAI_API_KEY
MNEMONIC=“your seed phrase” 
```
**Warning**: This mnemonic will be used to sign real transactions. Use a dedicated wallet with minimal or test-only funds to avoid putting significant assets at risk.
 
## Installation

1. Install dependencies

```
pnpm install
```
2. Build the project
```
pnpm build
```

## Running the Agent
```
pnpm start
```

**Disclaimer**: This agent is a demo and is not guaranteed to generate profits or be secure for production use. Use at your own risk.
