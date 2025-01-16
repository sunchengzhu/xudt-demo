import { addressToScript } from "@nervosnetwork/ckb-sdk-utils";
import { collector } from "./env";
import BigNumber from 'bignumber.js'


const address = 'ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqfy4w0gqjsm0ulnq0l4ft6hu6spztrj72sjtcnx4';

// https://testnet.explorer.nervos.org/xudt/0x45b32a2bc4285d0a09678eb11960ddc8707bc2779887a09d482e9bfe9a2cdf52
const xudtTypeScript: CKBComponents.Script = {
  codeHash: '0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a',
  hashType: 'type',
  args: '0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b'
};

const fetchXudtBalance = async (address: string, xudtTypeScript: CKBComponents.Script) => {
  const lockScript = addressToScript(address);

  // 使用 collector 来获取与该锁脚本和类型脚本相关联的所有单元格
  const cells = await collector.getCells({
    lock: lockScript,
    type: xudtTypeScript,
  });

  const totalAmount = cells.reduce((acc, cell) => {
    const result = hexToXudtData(cell.outputData);
    const amount: bigint = BigInt(result.AMOUNT || '0');  // 使用解析后的 AMOUNT，若无则为 '0'
    return acc + amount;
  }, BigInt(0));
  return new BigNumber(totalAmount.toString()).dividedBy(100000000).toFixed(8);
};

const leToBe = (v: string) => {
  // to big endian
  const bytes = v.slice(2).match(/\w{2}/g)
  if (!bytes) return ''
  const be = `0x${bytes.reverse().join('')}`
  if (Number.isNaN(+be)) {
    throw new Error('Invalid little-endian')
  }
  return be
}

const hexToXudtData = (v: string) => {
  const amount = v.slice(0, 34)
  const res: Partial<Record<'AMOUNT' | 'DATA', string>> = {
    AMOUNT: new BigNumber(leToBe(amount)).toFormat({groupSeparator: ''}),
  }
  const data = v.slice(34)
  if (data) {
    res.DATA = data
  }
  return res
}

fetchXudtBalance(address, xudtTypeScript)
  .then(balance => console.log(`RUSD balance: ${balance}`))
  .catch(error => console.error('Error fetching RUSD balance:', error));
