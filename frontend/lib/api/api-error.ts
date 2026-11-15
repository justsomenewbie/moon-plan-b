// The error type and retry rule every page's query client needs. They live apart from client.ts so a page
// that makes no API call (the home page) does not download the request and validation code with them.
export const isMock = (process.env.NEXT_PUBLIC_API_BASE_URL || "mock") === "mock";
export class ApiError extends Error {
  status: number;
  code?: string;
  title?: string;
  hint?: string;
  fields: { path: string; message: string }[] = [];
  retryAt?: string;
  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}
export const retryQuery = (failureCount: number, error: Error) => failureCount < 2 && error instanceof ApiError && !error.retryAt && (isMock || error.status !== 504) && (error.status === 0 || error.status >= 500);
