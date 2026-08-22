export interface CardProps {
  kicker?: React.ReactNode;
  title?: React.ReactNode;
  meta?: React.ReactNode;
  children?: React.ReactNode;
  padding?: number;
}
export function Card(props: CardProps): JSX.Element;
