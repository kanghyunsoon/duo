// duo: APP-01
export function login(user: string): boolean {
  return validate(user);
}

function validate(user: string): boolean {
  return user.length > 0;
}

// duo: NOPE-99
export function logout(): void {}
