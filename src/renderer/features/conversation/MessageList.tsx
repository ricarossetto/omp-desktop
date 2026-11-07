import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ToolExecution } from "@shared/session-types";
import { Icon } from "../../components/Icon";
import { useT } from "../../i18n";
import { MessageItem, type MessageAction } from "./MessageItem";
import { computeOffsets, computeVirtualWindow, findIndexAt, indexOfKey } from "./virtual-window";

const ESTIMATED_HEIGHT = 150;
const STICK_THRESHOLD = 80;

interface AnchorSnapshot {
	firstKey: string;
	firstIndex: number;
	firstOffset: number;
	top: number;
}

export interface MessageListProps {
	messages: ChatMessage[];
	tools: Record<string, ToolExecution>;
	onOpenLink: (href: string) => void;
	onMessageAction: (message: ChatMessage, action: MessageAction) => void;
}

/**
 * Lista virtualizada própria: mede as mensagens montadas, estima as demais e
 * mantém a posição visual quando histórico é prependado.
 */
export function MessageList({ messages, tools, onOpenLink, onMessageAction }: MessageListProps) {
	const t = useT();
	const scrollRef = useRef<HTMLDivElement>(null);
	const heightsRef = useRef(new Map<string, number>());
	const observerRef = useRef<ResizeObserver | null>(null);
	const anchorRef = useRef<AnchorSnapshot | null>(null);
	const rafRef = useRef(0);
	const stickRef = useRef(true);

	const [measureVersion, setMeasureVersion] = useState(0);
	const [scrollTop, setScrollTop] = useState(0);
	const [viewportHeight, setViewportHeight] = useState(600);
	const [atBottom, setAtBottom] = useState(true);

	const keys = useMemo(() => messages.map((message) => message.key), [messages]);

	const heightAt = useCallback(
		(index: number) => {
			const key = messages[index]?.key;
			if (!key) return ESTIMATED_HEIGHT;
			return heightsRef.current.get(key) ?? ESTIMATED_HEIGHT;
		},
		[messages],
	);

	const virtual = useMemo(
		() =>
			computeVirtualWindow({
				itemCount: messages.length,
				heightAt,
				scrollTop,
				viewportHeight,
				overscan: 4,
			}),
		[messages.length, heightAt, scrollTop, viewportHeight, measureVersion],
	);

	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		const observer = new ResizeObserver(() => {
			setViewportHeight(element.clientHeight);
		});
		observer.observe(element);
		setViewportHeight(element.clientHeight);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const observer = new ResizeObserver((entries) => {
			let changed = false;
			for (const entry of entries) {
				const element = entry.target as HTMLElement;
				const key = element.dataset.msgKey;
				if (!key) continue;
				const height = element.getBoundingClientRect().height;
				const previous = heightsRef.current.get(key);
				if (previous === undefined || Math.abs(previous - height) > 0.5) {
					heightsRef.current.set(key, height);
					changed = true;
				}
			}
			if (changed) setMeasureVersion((value) => value + 1);
		});
		observerRef.current = observer;
		return () => {
			observer.disconnect();
			observerRef.current = null;
		};
	}, []);

	useLayoutEffect(() => {
		const observer = observerRef.current;
		const container = scrollRef.current;
		if (!observer || !container) return;
		observer.disconnect();
		const nodes = container.querySelectorAll<HTMLElement>("[data-msg-key]");
		nodes.forEach((node) => observer.observe(node));
	}, [virtual.start, virtual.end, messages, measureVersion]);

	const updateScrollMetrics = useCallback(() => {
		const element = scrollRef.current;
		if (!element) return;
		const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
		const nextAtBottom = distance <= STICK_THRESHOLD;
		stickRef.current = nextAtBottom;
		setAtBottom(nextAtBottom);
	}, []);

	useEffect(
		() => () => {
			cancelAnimationFrame(rafRef.current);
		},
		[],
	);

	const handleScroll = useCallback(() => {
		if (rafRef.current) return;
		rafRef.current = requestAnimationFrame(() => {
			rafRef.current = 0;
			const element = scrollRef.current;
			if (!element) return;
			setScrollTop(element.scrollTop);
			updateScrollMetrics();
		});
	}, [updateScrollMetrics]);

	// Preserva âncora em prepend e mantém o fundo fixo quando o usuário está nele.
	useLayoutEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		const previous = anchorRef.current;
		if (previous) {
			const newIndex = indexOfKey(keys, previous.firstKey);
			if (newIndex > previous.firstIndex) {
				const offsets = computeOffsets(messages.length, heightAt);
				const target = offsets[newIndex] + (previous.top - previous.firstOffset);
				element.scrollTop = Math.max(0, target);
			}
		}
		if (stickRef.current) element.scrollTop = element.scrollHeight;

		const top = element.scrollTop;
		const offsets = computeOffsets(messages.length, heightAt);
		const index = messages.length > 0 ? findIndexAt(offsets, top) : 0;
		const key = keys[index];
		anchorRef.current = key
			? { firstKey: key, firstIndex: index, firstOffset: offsets[index], top }
			: null;
		// Não atualiza scrollTop aqui: o evento de scroll (handleScroll) já sincroniza o estado.
		// Um setState em layout effect sem dependências realimenta o render quando a altura medida muda.
	});

	const jumpToLastResponse = useCallback(() => {
		const element = scrollRef.current;
		if (!element) return;
		let targetIndex = -1;
		for (let index = messages.length - 1; index >= 0; index--) {
			if (messages[index]?.role === "assistant") {
				targetIndex = index;
				break;
			}
		}
		if (targetIndex < 0) {
			stickRef.current = true;
			element.scrollTop = element.scrollHeight;
			setAtBottom(true);
			return;
		}
		const offsets = computeOffsets(messages.length, heightAt);
		element.scrollTop = Math.max(0, offsets[targetIndex] - 8);
		stickRef.current = false;
		setAtBottom(false);
		setScrollTop(element.scrollTop);
	}, [messages, heightAt]);

	const streaming = useMemo(() => messages.some((message) => message.streaming), [messages]);
	const lastAssistantExists = useMemo(
		() => messages.some((message) => message.role === "assistant"),
		[messages],
	);

	if (messages.length === 0) {
		return <div className="messages messages--empty" ref={scrollRef} />;
	}

	return (
		<div className="messages-wrap">
			<div
				ref={scrollRef}
				className="messages"
				onScroll={handleScroll}
				tabIndex={0}
				role="log"
				aria-label={t("message.historyLabel")}
			>
				<div style={{ height: virtual.padTop }} aria-hidden="true" />
				{messages.slice(virtual.start, virtual.end).map((message) => (
					<div key={message.key} className="message-slot" data-msg-key={message.key}>
						<MessageItem
							message={message}
							tools={tools}
							onOpenLink={onOpenLink}
							onMessageAction={onMessageAction}
						/>
					</div>
				))}
				<div style={{ height: virtual.padBottom }} aria-hidden="true" />
			</div>
			{!atBottom && (streaming || lastAssistantExists) ? (
				<button type="button" className="jump-response" onClick={jumpToLastResponse}>
					<Icon name="arrow-down" className="icon--sm" />
					{t("message.jumpToResponse")}
				</button>
			) : null}
		</div>
	);
}
