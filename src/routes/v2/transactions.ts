import { fromHex, toHex } from 'chia-bls';
import { addressInfo, toAddress, toCoinId } from 'chia-rpc';
import { app, blockchains, fullNodes } from '../..';
import {
    ReceiveTransactionGroup,
    SendTransactionGroup,
    TransactionGroup,
} from '../../types/TransactionGroup';
import { logger } from '../../utils/logger';

interface Transactions {
    transaction_groups: TransactionGroup[];
}

app.post('/api/v2/transactions', async (req, res) => {
    try {
        const { address: addressText } = req.body;

        if (!addressText) return res.status(400).send('Missing address');

        if (typeof addressText !== 'string')
            return res.status(400).send('Invalid address');
        
        const address = addressInfo(addressText);

        if (!(address.prefix in blockchains))
            return res.status(400).send('Invalid blockchain');
        
        if (!(address.prefix in fullNodes))
            return res.status(400).send('Unimplemented blockchain');
        
        const node = fullNodes[address.prefix]!;
        const recordsResult = await node.getCoinRecordsByPuzzleHash(
            toHex(address.hash),
            undefined,
            undefined,
            true
        );

        if (!recordsResult.success)
            return res.status(500).send('Could not fetch coin records');
        
        const puzzleHash = toHex(address.hash);
        const sent: SendTransactionGroup[] = [];
        const received: Record<string, ReceiveTransactionGroup> = {};

        for (const record of recordsResult.coin_records) {
            if (record.coin.amount === 0) continue;

            const parentResult = await node.getCoinRecordByName(
                record.coin.parent_coin_info
            );

            if (!parentResult.success)
                return res
                    .status(500)
                    .send('Could not fetch parent coin record');
            
            if (parentResult.coin_record.coin.puzzle_hash !== puzzleHash) {
                if (!(record.coin.parent_coin_info in received)) {
                    received[record.coin.parent_coin_info] = {
                        type: 'receive',
                        transactions: [],
                        timestamp: record.timestamp,
                        block: record.confirmed_block_index,
                        amount: record.coin.amount,
                        fee: record.coin.amount,
                    };
                }

                const group = received[record.coin.parent_coin_info];

                group.transactions.push({
                    sender: toAddress(fromHex(parentResult.coin_record.coin.puzzle_hash), address.prefix),
                    amount: record.coin.amount,
                });

                group.fee -= record.coin.amount;
            }

            if (record.spent) {
                const coinId = toHex(toCoinId(record.coin));

                const blockResult = await node.getBlockRecordByHeight(
                    record.spent_block_index
                );

                if (!blockResult.success)
                    return res.status(500).send('Could not fetch block');
                
                const updatesResult = await node.getAdditionsAndRemovals(
                    blockResult.block_record.header_hash
                );

                if (!updatesResult.success)
                    return res
                        .status(500)
                        .send('Could not fetch additions and removals');
                
                const group: SendTransactionGroup = {
                    type: 'send',
                    transactions: [],
                    timestamp: blockResult.block_record.timestamp!,
                    block: record.spent_block_index,
                    amount: record.coin.amount,
                    fee: record.coin.amount,
                };

                for (const child of updatesResult.additions.filter(
                    (record) => record.coin.parent_coin_info === coinId
                )) {
                    if (child.coin.puzzle_hash !== puzzleHash)
                        group.transactions.push({
                            destination: toAddress(fromHex(child.coin.puzzle_hash), address.prefix),
                            amount: child.coin.amount,
                        });
                    
                    group.fee -= child.coin.amount;
                }
                
                sent.push(group);
            }
        }

        res.status(200).send({
            transaction_groups: (Object.values(received) as TransactionGroup[])
                .concat(sent)
                .sort((a, b) => b.timestamp - a.timestamp),
        } as Transactions);
    } catch (error) {
        logger.error(`${error}`);
        return res.status(500).send('Could not fetch transactions');
    }
});
