describe('read-only runtime logging', () => {
  afterEach(() => jest.resetModules());

  test('ERROR still reaches stderr when debug.log cannot be written', () => {
    jest.unmock('../src/logger');
    jest.doMock('fs', () => ({
      readFileSync: jest.fn(() => 'log_level: ERROR\n'),
      appendFileSync: jest.fn(() => { throw new Error('EROFS'); }),
    }));
    jest.doMock('fancy-log', () => ({info: jest.fn(), error: jest.fn()}));

    jest.isolateModules(() => {
      const logger = require('../src/logger');
      const fancyLog = require('fancy-log');
      expect(() => logger.error('safe failure')).not.toThrow();
      expect(fancyLog.error).toHaveBeenCalledWith('safe failure');
    });
  });
});
