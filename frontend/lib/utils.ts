import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Standard class-name merge helper the scaffold's components rely on.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
