// Test with the correct method
import * as whoiser from 'whoiser';

async function test() {
  try {
    console.log('Testing whoiser.whoisDomain...');
    const result = await whoiser.whoisDomain('redcross.org');
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

test();