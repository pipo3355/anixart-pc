// Нужен парсеру VK для случайного идентификатора устройства
module.exports = {
  randomUUID: () => globalThis.crypto.randomUUID(),
};
