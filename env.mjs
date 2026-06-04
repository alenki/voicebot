// Проверка обязательных переменных окружения на СТАРТЕ — чтобы отсутствующий ключ падал
// понятной ошибкой при запуске, а не безликим «fetch failed» в середине живого звонка.
// Чистые функции (env передаётся аргументом) — юнит-тестируются без подмены process.env.

// Какие из keys отсутствуют или пусты (только пробелы) в env.
export function missingKeys(env, keys) {
  return keys.filter((k) => !env[k] || !String(env[k]).trim());
}

// Бросает, если хоть один обязательный ключ не задан. label попадает в текст ошибки.
export function assertEnv(env, keys, label = "обязательные") {
  const missing = missingKeys(env, keys);
  if (missing.length) {
    throw new Error(
      `Не заданы переменные окружения (${label}): ${missing.join(", ")}. Проверьте .env / --env-file`,
    );
  }
}
