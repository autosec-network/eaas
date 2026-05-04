import { $, component$ } from '@builder.io/qwik';
import { useLocation, useNavigate } from '@builder.io/qwik-city';
import { LuChevronLeft, LuChevronRight } from '@qwikest/icons/lucide';

interface PaginationProps {
	page: number;
	totalPages: number;
	totalItems: number;
	pageSize: number;
}

export const Pagination = component$<PaginationProps>((props) => {
	const loc = useLocation();
	const nav = useNavigate();

	const buildPageUrl = (page: number) => {
		const params = new URLSearchParams(loc.url.search);
		params.set('page', String(page));
		return `?${params.toString()}`;
	};

	const startItem = props.totalItems === 0 ? 0 : (props.page - 1) * props.pageSize;
	const endItem = props.totalItems === 0 ? 0 : Math.min(props.page * props.pageSize, props.totalItems) - 1;

	const goToPage = $((page: number) => {
		const params = new URLSearchParams(loc.url.search);
		params.set('page', String(page));
		nav(`?${params.toString()}`);
	});

	const pageOptions = Array.from({ length: props.totalPages }, (_, i) => i + 1);

	return (
		<nav class="flex items-center justify-between px-4 py-3" aria-label="Pagination">
			<span class="text-body-subtle text-sm dark:text-gray-400">
				Showing <span class="font-semibold dark:text-white">{startItem}</span> - <span class="font-semibold dark:text-white">{endItem}</span> of <span class="font-semibold dark:text-white">{props.totalItems}</span>
			</span>
			<div class="flex items-center gap-1">
				{props.page > 1 ? (
					<div class="relative inline-flex items-center">
						<a href={buildPageUrl(props.page - 1)} class="border-default-medium inline-flex items-center rounded-l-lg border px-3 py-2 text-sm font-medium hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-700">
							<LuChevronLeft class="mr-1 h-4 w-4" />
							{props.page - 1}
						</a>
						{props.page > 2 && (
							<select
								class="border-default-medium absolute inset-0 cursor-pointer rounded-l-lg border opacity-0"
								onChange$={(_, el) => {
									const val = parseInt(el.value, 10);
									if (val) goToPage(val);
								}}>
								<option value="">Jump to…</option>
								{pageOptions
									.filter((p) => p < props.page)
									.map((p) => (
										<option key={p} value={p}>
											{`Page ${p}`}
										</option>
									))}
							</select>
						)}
					</div>
				) : (
					<span class="border-default-medium inline-flex items-center rounded-l-lg border px-3 py-2 text-sm font-medium opacity-50 dark:border-gray-700">
						<LuChevronLeft class="mr-1 h-4 w-4" />—
					</span>
				)}
				{props.page < props.totalPages ? (
					<div class="relative inline-flex items-center">
						<a href={buildPageUrl(props.page + 1)} class="border-default-medium inline-flex items-center rounded-r-lg border px-3 py-2 text-sm font-medium hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-700">
							{props.page + 1}
							<LuChevronRight class="ml-1 h-4 w-4" />
						</a>
						{props.totalPages - props.page > 1 && (
							<select
								class="border-default-medium absolute inset-0 cursor-pointer rounded-r-lg border opacity-0"
								onChange$={(_, el) => {
									const val = parseInt(el.value, 10);
									if (val) goToPage(val);
								}}>
								<option value="">Jump to…</option>
								{pageOptions
									.filter((p) => p > props.page)
									.map((p) => (
										<option key={p} value={p}>
											{`Page ${p}`}
										</option>
									))}
							</select>
						)}
					</div>
				) : (
					<span class="border-default-medium inline-flex items-center rounded-r-lg border px-3 py-2 text-sm font-medium opacity-50 dark:border-gray-700">
						—
						<LuChevronRight class="ml-1 h-4 w-4" />
					</span>
				)}
			</div>
		</nav>
	);
});
