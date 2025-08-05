import { addressToScript, getTransactionSize } from '@nervosnetwork/ckb-sdk-utils';
import {
  getSecp256k1CellDep,
  RgbppTokenInfo,
  NoLiveCellError,
  calculateUdtCellCapacity,
  MAX_FEE,
  MIN_CAPACITY,
  append0x,
  u128ToLe,
  SECP256K1_WITNESS_LOCK_SIZE,
  calculateTransactionFee,
  NoXudtLiveCellError,
  fetchTypeIdCellDeps,
  getXudtTypeScript,
} from '@rgbpp-sdk/ckb';
import { CKB_PRIVATE_KEY, ckbAddress, collector, isMainnet } from './env';
import * as fs from 'fs/promises';
import * as path from 'path';
import BigNumber from 'bignumber.js';

const XUDT_TOKEN_INFO: RgbppTokenInfo = {
  decimal: 8,
  name: 'XUDT Test Token',
  symbol: 'XTT',
};

// ========== 读取地址文件，逐个查余额并补齐至100 ==========
async function main() {
  // 读取所有地址
  const filePath = path.resolve('./addresses.txt');
  const content = await fs.readFile(filePath, 'utf-8');
  const addresses = content.split('\n').map(line => line.trim()).filter(Boolean);

  // transferXudt 接收所有地址（余额判断和批量组装 receivers 在 transferXudt 里完成）
  await transferXudt({
    xudtType: {
      ...getXudtTypeScript(isMainnet),
      args: '0xd2caac2a880649aa0a3c81c382cce795f962188cd9efa8c0194e4dae07120eef',
    },
    allAddresses: addresses,
    targetAmount: 100n, // 目标补齐 100
  });
}

main().catch(e => {
  console.error(e);
});

// ========== 查询 xUDT 余额工具 ==========
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
    AMOUNT: new BigNumber(leToBe(amount)).toFormat({groupSeparator: ''}),
  };
  const data = v.slice(34);
  if (data) {
    res.DATA = data;
  }
  return res;
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
  // 返回BigNumber，方便后续做小数运算
  return new BigNumber(totalAmount.toString()).dividedBy(10 ** XUDT_TOKEN_INFO.decimal);
};

// ========== transferXudt 内部自动判断余额并组装 receivers ==========
interface XudtTransferParams {
  xudtType: CKBComponents.Script;
  allAddresses: string[];
  targetAmount?: bigint; // 目标补齐值，默认100
}

const transferXudt = async ({
                              xudtType,
                              allAddresses,
                              targetAmount = 100n,
                            }: XudtTransferParams) => {
  // 查询每个地址的余额
  const balances = await Promise.all(
    allAddresses.map(addr => fetchXudtBalance(addr, xudtType))
  );

  // 组装需要补齐的 receivers
  const receivers: { toAddress: string; transferAmount: bigint }[] = [];
  let index = 0;
  for (const addr of allAddresses) {
    const balance = balances[index];
    if (balance.isLessThan(targetAmount)) {
      // 需补齐的数量 = targetAmount - 当前余额（最小单位）
      const topupAmount = new BigNumber(targetAmount.toString()).minus(balance);
      receivers.push({
        toAddress: addr,
        transferAmount: BigInt(topupAmount.multipliedBy(10 ** XUDT_TOKEN_INFO.decimal).toFixed(0)),
      });
      console.log(
        `Address ${index + 1} ${addr} balance: ${balance.toFixed(8)}. Will top up: ${topupAmount.toFixed(8)}`
      );
    } else {
      console.log(
        `Address ${index + 1} ${addr} balance: ${balance.toFixed(8)}. No top-up needed.`
      );
    }
    index++;
  }

  if (receivers.length === 0) {
    console.log('No transfer needed. All addresses have a balance greater than 100.');
    return;
  }

  // 调用实际转账逻辑
  await doXudtTransfer({xudtType, receivers});
};

// ========== 实际批量转账实现，复用你的原 transferXudt 代码 ==========
interface ActualTransferParams {
  xudtType: CKBComponents.Script;
  receivers: {
    toAddress: string;
    transferAmount: bigint;
  }[];
}

const doXudtTransfer = async ({xudtType, receivers}: ActualTransferParams) => {
  const fromLock = addressToScript(ckbAddress);

  const xudtCells = await collector.getCells({
    lock: fromLock,
    type: xudtType,
  });
  if (!xudtCells || xudtCells.length === 0) {
    throw new NoXudtLiveCellError('The address has no xudt cells');
  }
  const sumTransferAmount = receivers
    .map((receiver) => receiver.transferAmount)
    .reduce((prev, current) => prev + current, BigInt(0));

  let sumXudtOutputCapacity = receivers
    .map(({toAddress}) => calculateUdtCellCapacity(addressToScript(toAddress)))
    .reduce((prev, current) => prev + current, BigInt(0));

  const {
    inputs: udtInputs,
    sumInputsCapacity: sumXudtInputsCapacity,
    sumAmount,
  } = collector.collectUdtInputs({
    liveCells: xudtCells,
    needAmount: sumTransferAmount,
  });
  let actualInputsCapacity = sumXudtInputsCapacity;
  let inputs = udtInputs;

  const outputs: CKBComponents.CellOutput[] = receivers.map(({toAddress}) => ({
    lock: addressToScript(toAddress),
    type: xudtType,
    capacity: append0x(calculateUdtCellCapacity(addressToScript(toAddress)).toString(16)),
  }));
  const outputsData = receivers.map(({transferAmount}) => append0x(u128ToLe(transferAmount)));

  if (sumAmount > sumTransferAmount) {
    const xudtChangeCapacity = calculateUdtCellCapacity(fromLock);
    outputs.push({
      lock: fromLock,
      type: xudtType,
      capacity: append0x(xudtChangeCapacity.toString(16)),
    });
    outputsData.push(append0x(u128ToLe(sumAmount - sumTransferAmount)));
    sumXudtOutputCapacity += xudtChangeCapacity;
  }

  const txFee = MAX_FEE;
  if (sumXudtInputsCapacity <= sumXudtOutputCapacity) {
    let emptyCells = await collector.getCells({
      lock: fromLock,
    });
    if (!emptyCells || emptyCells.length === 0) {
      throw new NoLiveCellError('The address has no empty cells');
    }
    emptyCells = emptyCells.filter((cell) => !cell.output.type);
    const needCapacity = sumXudtOutputCapacity - sumXudtInputsCapacity;
    const {inputs: emptyInputs, sumInputsCapacity: sumEmptyCapacity} = collector.collectInputs(
      emptyCells,
      needCapacity,
      txFee,
      {minCapacity: MIN_CAPACITY},
    );
    inputs = [...inputs, ...emptyInputs];
    actualInputsCapacity += sumEmptyCapacity;
  }

  let changeCapacity = actualInputsCapacity - sumXudtOutputCapacity;
  outputs.push({
    lock: fromLock,
    capacity: append0x(changeCapacity.toString(16)),
  });
  outputsData.push('0x');

  const emptyWitness = {lock: '', inputType: '', outputType: ''};
  const witnesses = inputs.map((_, index) => (index === 0 ? emptyWitness : '0x'));

  const cellDeps = [getSecp256k1CellDep(isMainnet), ...(await fetchTypeIdCellDeps(isMainnet, {xudt: true}))];

  const unsignedTx = {
    version: '0x0',
    cellDeps,
    headerDeps: [],
    inputs,
    outputs,
    outputsData,
    witnesses,
  };

  if (txFee === MAX_FEE) {
    const txSize = getTransactionSize(unsignedTx) + SECP256K1_WITNESS_LOCK_SIZE;
    const estimatedTxFee = calculateTransactionFee(txSize);
    changeCapacity -= estimatedTxFee;
    unsignedTx.outputs[unsignedTx.outputs.length - 1].capacity = append0x(changeCapacity.toString(16));
  }

  const signedTx = collector.getCkb().signTransaction(CKB_PRIVATE_KEY)(unsignedTx);
  const txHash = await collector.getCkb().rpc.sendTransaction(signedTx, 'passthrough');

  console.info(`xUDT assets have been successfully transferred. Transaction hash: ${txHash}`);
};
