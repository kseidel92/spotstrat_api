import { infeasiblePrompt, nonExecutableJs } from '../src/feasibility.js';
import { interpret } from '../src/interpret.js';
import assert from 'assert';

assert(infeasiblePrompt('comprar quando a lua estiver cheia', 'pt-BR')?.failed);
assert(infeasiblePrompt('spread ETH/BTC igual a pi exato', 'pt-BR')?.failed);
assert(!infeasiblePrompt('comprar no rompimento 15m', 'pt-BR'));
assert(infeasiblePrompt('oi', 'pt-BR')?.failed);

const p = `No 1h, compra se o candle fechar acima da máxima das 20 velas anteriores e o volume for 1,5x a média`;
assert(interpret(p)?.plan?.kind === 'donchian', 'donchian matcher');

const dead = `function strategy(ctx) { const lua = false; if (!lua) return {action:"hold"}; }`;
assert(nonExecutableJs(dead) === 'lua');

console.log('test-feasibility: ok');
