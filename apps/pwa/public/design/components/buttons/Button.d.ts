export interface ButtonProps {
  /** primary = the one main action on the screen. */
  variant?: 'primary' | 'secondary' | 'success' | 'danger' | 'ghost';
  size?: 'md' | 'lg';
  icon?: React.ReactNode;
  fullWidth?: boolean;
  disabled?: boolean;
  children?: React.ReactNode;
  onClick?: () => void;
}
export function Button(props: ButtonProps): JSX.Element;
