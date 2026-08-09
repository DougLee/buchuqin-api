export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
  timestamp: string;
}
export function ok<T>(data: T, message = 'success'): ApiResponse<T> {
  return { code: 0, message, data, timestamp: new Date().toISOString() };
}
