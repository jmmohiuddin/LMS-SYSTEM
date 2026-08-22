export interface SearchInputProps {
  placeholder?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
}
export function SearchInput(props: SearchInputProps): JSX.Element;
