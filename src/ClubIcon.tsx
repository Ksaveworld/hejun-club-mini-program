export type ClubIconName =
  | 'AllApplication'
  | 'BookOpen'
  | 'BuildingTwo'
  | 'Check'
  | 'Edit'
  | 'Gift'
  | 'Home'
  | 'IdCard'
  | 'Left'
  | 'NewspaperFolding'
  | 'Order'
  | 'People'
  | 'PeoplesTwo'
  | 'Right'
  | 'Search'
  | 'Slide'
  | 'Time'
  | 'Translate';

export type ClubIconVariant = '双色' | '轮廓' | '选中';

export interface ClubIconProps {
  name: ClubIconName;
  variant?: ClubIconVariant;
  size?: number;
  className?: string;
}

export function ClubIcon({
  name,
  variant = '双色',
  size = 24,
  className,
}: ClubIconProps) {
  const resolvedVariant =
    variant === '双色' && (name === 'Left' || name === 'Right' || name === 'Search')
      ? '轮廓'
      : variant;

  return (
    <img
      src={`${import.meta.env.BASE_URL}icons/iconpark-gold/${name}-${resolvedVariant}.svg`}
      width={size}
      height={size}
      className={`club-icon${className ? ` ${className}` : ''}`}
      data-icon={name}
      data-variant={resolvedVariant}
      aria-hidden={true}
      alt=""
    />
  );
}
