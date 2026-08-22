export interface AlertProps {
  tone?: 'info' | 'success' | 'warning' | 'danger' | 'neutral';
  icon?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
}
export function Alert(props: AlertProps): JSX.Element;
