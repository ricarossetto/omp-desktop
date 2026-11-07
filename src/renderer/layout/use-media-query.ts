import { useEffect, useState } from "react";

/** Escuta uma media query sem depender de CSS apenas para lógica de layout. */
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() =>
		typeof window !== "undefined" ? window.matchMedia(query).matches : false,
	);

	useEffect(() => {
		const media = window.matchMedia(query);
		const listener = (event: MediaQueryListEvent) => setMatches(event.matches);
		setMatches(media.matches);
		media.addEventListener("change", listener);
		return () => media.removeEventListener("change", listener);
	}, [query]);

	return matches;
}
