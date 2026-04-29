const fs = require('fs');
const path = require('path');
describe('contract', () => {
  it('should have an openapi file', () => {
    const spec = fs.readFileSync(path.join(__dirname, '../openapi.yaml'), 'utf-8');
    expect(spec).toBeTruthy();
  });
});