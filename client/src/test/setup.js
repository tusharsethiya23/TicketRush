import '@testing-library/jest-dom/vitest';

// With `globals: true`, Testing Library unmounts after each test on its own.
// The global afterEach is used because Vitest 5 rejects hooks imported into setup files.
globalThis.afterEach(() => {
  sessionStorage.clear();
});
