import { addressToScript } from "@nervosnetwork/ckb-sdk-utils";
import { collector } from "./env";
import BigNumber from 'bignumber.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const xudtTypeScript: CKBComponents.Script = {
  codeHash: '0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb',
  hashType: 'type',
  args: '0xd2caac2a880649aa0a3c81c382cce795f962188cd9efa8c0194e4dae07120eef'
};

const fetchXudtBalance = async (address: string, xudtTypeScript: CKBComponents.Script) => {
  const lockScript = addressToScript(address);
  const cells = await collector.getCells({
    lock: lockScript,
    type: xudtTypeScript,
  });

  const totalAmount = cells.reduce((acc, cell) => {
    const result = hexToXudtData(cell.outputData);
    const amount: bigint = BigInt(result.AMOUNT || '0');
    return acc + amount;
  }, BigInt(0));
  return new BigNumber(totalAmount.toString()).dividedBy(100000000).toFixed(8);
};

const leToBe = (v: string) => {
  const bytes = v.slice(2).match(/\w{2}/g);
  if (!bytes) return '';
  const be = `0x${bytes.reverse().join('')}`;
  if (Number.isNaN(+be)) {
    throw new Error('Invalid little-endian');
  }
  return be;
};

const hexToXudtData = (v: string) => {
  const amount = v.slice(0, 34);
  const res: Partial<Record<'AMOUNT' | 'DATA', string>> = {
    AMOUNT: new BigNumber(leToBe(amount)).toFormat({ groupSeparator: '' }),
  };
  const data = v.slice(34);
  if (data) {
    res.DATA = data;
  }
  return res;
};

async function fetchAndLogBalancesFromFile(filePath: string) {
  try {
    const absPath = path.resolve(filePath);
    const content = await fs.readFile(absPath, 'utf-8');
    const addresses = content.split('\n').map(line => line.trim()).filter(Boolean);

    for (let i = 0; i < addresses.length; i++) {
      const address = addresses[i];
      const balance = await fetchXudtBalance(address, xudtTypeScript);
      console.log(`Address ${i + 1} ${address} XTT balance: ${balance}`);
    }
  } catch (error) {
    console.error('Error fetching balances:', error);
  }
}

// 假设文件名是 addresses.txt
fetchAndLogBalancesFromFile('./addresses.txt');
