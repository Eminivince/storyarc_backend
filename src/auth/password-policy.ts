import { BadRequestException } from "@nestjs/common";

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

const LOWERCASE_PATTERN = /[a-z]/;
const UPPERCASE_PATTERN = /[A-Z]/;
const NUMBER_PATTERN = /\d/;
const SPECIAL_CHARACTER_PATTERN = /[^A-Za-z0-9]/;
const WHITESPACE_PATTERN = /\s/;

export function getPasswordPolicyChecks(value: string) {
  return {
    hasLowercase: LOWERCASE_PATTERN.test(value),
    hasNumber: NUMBER_PATTERN.test(value),
    hasSpecialCharacter: SPECIAL_CHARACTER_PATTERN.test(value),
    hasUppercase: UPPERCASE_PATTERN.test(value),
    hasValidLength:
      value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH,
    hasWhitespace: WHITESPACE_PATTERN.test(value),
  };
}

export function getPasswordPolicyMessage() {
  return `password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters long and include at least one uppercase letter, one lowercase letter, one number, and one special character, with no spaces.`;
}

export function validateStrongPassword(value: string, fieldName = "password") {
  if (typeof value !== "string") {
    throw new BadRequestException(`${fieldName} must be a string.`);
  }

  const checks = getPasswordPolicyChecks(value);

  if (checks.hasWhitespace) {
    throw new BadRequestException(`${fieldName} cannot contain spaces.`);
  }

  if (
    !checks.hasValidLength ||
    !checks.hasLowercase ||
    !checks.hasUppercase ||
    !checks.hasNumber ||
    !checks.hasSpecialCharacter
  ) {
    throw new BadRequestException(getPasswordPolicyMessage());
  }

  return value;
}
